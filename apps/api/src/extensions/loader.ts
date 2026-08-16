import type { FastifyBaseLogger } from 'fastify'
import { withOrg } from '@project-vault/db'
import { AuditEvent, OperationalEvent } from '@project-vault/shared'
import {
  EXTENSION_API_VERSION,
  ExtensionRegistrationError,
  isExtensionApiVersionSupported,
  registerExtension,
} from '@project-vault/extension-api'
import type { ExtensionHooks, ExtensionManifest } from '@project-vault/extension-api'
import { operationalLog } from '../lib/logger.js'
import { writeSystemAuditRow } from '../lib/system-audit-row.js'
import { fetchAllOrgIds } from '../middleware/rls.js'

/**
 * Story 14.2 AC-3: fixed, exhaustive failure-reason enum — never the raw exception
 * message/stack (see loadExtension()'s mapFailureReason()). `hooksFactory()` crashes and
 * load timeouts (AC-3d/3e, Dev Notes judgment call #2) both map to `'import_error'` — the
 * closest semantic fit — rather than inventing a 4th value not sanctioned by epics.md's
 * literal AC text.
 */
export type ExtensionLoadFailureReason = 'import_error' | 'manifest_invalid' | 'capability_mismatch'

export type ExtensionState =
  | { status: 'not_configured' }
  | { status: 'loaded'; manifest: ExtensionManifest; loadedAt: string; hooks: ExtensionHooks }
  | { status: 'load_failed'; reason: ExtensionLoadFailureReason }

type ExtensionModuleShape = {
  default: { manifest: ExtensionManifest; hooksFactory: () => ExtensionHooks }
}

type ImportFn = (specifier: string) => Promise<ExtensionModuleShape>
type ListOrgIdsFn = () => Promise<string[]>
type AuditWriterFn = (
  orgId: string,
  eventType: string,
  payload: Record<string, unknown>
) => Promise<void>
type LoaderLogger = Pick<FastifyBaseLogger, 'warn' | 'fatal'>

export type LoadExtensionDeps = {
  /** Injectable dynamic-import seam — defaults to native ESM `import()`. Tests supply a fixture. */
  importFn?: ImportFn
  /** Injectable org enumeration — defaults to `fetchAllOrgIds()` (all existing orgs). */
  listOrgIds?: ListOrgIdsFn
  /** Injectable per-org audit write — defaults to `withOrg(orgId, writeSystemAuditRow)`. */
  auditWriter?: AuditWriterFn
  /** Boot-time structured logger (e.g. `fastify.log`). Defaults to a silent no-op. */
  logger?: LoaderLogger
  /** Bounded timeout (ms) wrapping the import()+hooksFactory chain. Defaults to 5000. */
  timeoutMs?: number
  /** Incident-only rollback escape; relaxes the host-version ceiling, never shape or major. */
  allowApiVersionAboveHost?: boolean
}

const DEFAULT_TIMEOUT_MS = 5000

const defaultImportFn: ImportFn = (specifier) =>
  import(/* @vite-ignore */ specifier) as Promise<ExtensionModuleShape>

const defaultAuditWriter: AuditWriterFn = (orgId, eventType, payload) =>
  withOrg(orgId, (tx) => writeSystemAuditRow(tx, { orgId, eventType, payload }))

const silentLogger: LoaderLogger = {
  warn: () => undefined,
  fatal: () => undefined,
} as unknown as LoaderLogger

let state: ExtensionState = { status: 'not_configured' }

export function getExtensionStatus(): ExtensionState {
  return state
}

export function getExtensionsHealthField(): ExtensionState['status'] {
  return state.status
}

/** Test-only reset of module-level state — never called from production code. */
export function __resetExtensionStateForTests(): void {
  state = { status: 'not_configured' }
}

function mapFailureReason(error: unknown): ExtensionLoadFailureReason {
  if (error instanceof ExtensionRegistrationError) {
    // Story 23.2 AC-2 (finding H5): 'invalid-manifest-field' (the replacesNativeLogin /
    // near-miss-key validation reason) maps to the same public 'manifest_invalid' value as
    // 'invalid-name' — no new ExtensionLoadFailureReason is added, so Story 14.2's /health
    // contract is unchanged. 'incompatible-version' remains the only reason mapped to
    // 'capability_mismatch'.
    return error.reason === 'invalid-name' || error.reason === 'invalid-manifest-field'
      ? 'manifest_invalid'
      : 'capability_mismatch'
  }
  // AC-3d (hooksFactory crash) and AC-3e (timeout) both land here — closest semantic fit,
  // see the type-level comment on ExtensionLoadFailureReason above.
  return 'import_error'
}

/**
 * Dev Notes judgment call #1/#4: boot-time extension load has no natural single org — fan the
 * audit write out to every existing org, isolating each org's write failure (log-and-continue)
 * so neither a single bad org nor a wholesale enumeration failure can affect loadExtension()'s
 * own resolution or crash boot.
 */
async function runAuditFanout(
  eventType: string,
  payload: Record<string, unknown>,
  listOrgIds: ListOrgIdsFn,
  auditWriter: AuditWriterFn,
  logger: LoaderLogger
): Promise<void> {
  let orgIds: string[]
  try {
    orgIds = await listOrgIds()
  } catch {
    operationalLog(
      logger,
      'fatal',
      OperationalEvent.EXTENSION_AUDIT_FANOUT_ROW_FAILED,
      'extension audit fanout: failed to enumerate organizations',
      { subReason: 'org_enumeration_failed' }
    )
    return
  }

  for (const orgId of orgIds) {
    try {
      await auditWriter(orgId, eventType, payload)
    } catch {
      operationalLog(
        logger,
        'fatal',
        OperationalEvent.EXTENSION_AUDIT_FANOUT_ROW_FAILED,
        'extension audit fanout: per-org audit write failed',
        { orgId, subReason: 'audit_write_failed' }
      )
    }
  }
}

type LoadOutcome = { manifest: ExtensionManifest; hooks: ExtensionHooks }
type RaceResult = { outcome?: LoadOutcome; reason: ExtensionLoadFailureReason; message?: string }

/**
 * Dev Notes judgment call #2/#3: races the import()+registerExtension() chain against a bounded
 * timeout. A no-op `.catch()` is attached to the attempt promise immediately (before racing) so
 * a late rejection of the "losing" promise — after the timeout already won — can never produce
 * an unhandledRejection; a late resolution is simply never consumed (Promise.race only reads the
 * first settled promise), so it cannot retroactively mutate the caller's already-finalized state.
 */
async function raceWithTimeout(
  packageName: string,
  importFn: ImportFn,
  timeoutMs: number,
  allowApiVersionAboveHost: boolean
): Promise<RaceResult> {
  const attempt = (async (): Promise<LoadOutcome> => {
    const mod = await importFn(packageName)
    return registerExtension(mod.default.manifest, mod.default.hooksFactory, {
      allowApiVersionAboveHost,
    })
  })()
  attempt.catch(() => undefined)

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error('extension load timed out')), timeoutMs)
  })

  try {
    const outcome = await Promise.race([attempt, timeoutPromise])
    return { outcome, reason: 'import_error' }
  } catch (error) {
    return {
      reason: mapFailureReason(error),
      message:
        error instanceof ExtensionRegistrationError ? error.message.slice(0, 320) : undefined,
    }
  } finally {
    clearTimeout(timeoutHandle)
  }
}

function isDoubleInvocation(logger: LoaderLogger): boolean {
  if (state.status === 'not_configured') return false
  // Dev Notes judgment call #5: idempotency guard — a second invocation while state is already
  // resolved (loaded or load_failed) no-ops rather than re-running hooksFactory() or
  // overwriting state.
  operationalLog(
    logger,
    'warn',
    OperationalEvent.EXTENSION_LOAD_DOUBLE_INVOCATION_IGNORED,
    'loadExtension() called again after already resolving — ignoring',
    { currentStatus: state.status }
  )
  return true
}

async function applyOutcome(
  result: RaceResult,
  listOrgIds: ListOrgIdsFn,
  auditWriter: AuditWriterFn,
  logger: LoaderLogger,
  allowApiVersionAboveHost: boolean
): Promise<void> {
  if (result.outcome) {
    const { manifest, hooks } = result.outcome
    state = { status: 'loaded', manifest, loadedAt: new Date().toISOString(), hooks }
    if (allowApiVersionAboveHost && !isExtensionApiVersionSupported(manifest.apiVersion)) {
      operationalLog(
        logger,
        'warn',
        OperationalEvent.EXTENSION_API_VERSION_ABOVE_HOST_ALLOWED,
        'Extension loaded using the rollback API-version escape; roll the extension back to match the host',
        {
          declaredApiVersion: manifest.apiVersion,
          hostApiVersion: EXTENSION_API_VERSION,
          flag: 'VAULT_EXTENSIONS_ALLOW_API_VERSION_ABOVE_HOST',
        }
      )
    }
    await runAuditFanout(
      AuditEvent.EXTENSION_LOADED,
      { name: manifest.name, apiVersion: manifest.apiVersion, capabilities: manifest.capabilities },
      listOrgIds,
      auditWriter,
      logger
    )
    return
  }

  state = { status: 'load_failed', reason: result.reason }
  operationalLog(
    logger,
    'fatal',
    OperationalEvent.EXTENSION_LOAD_FAILED,
    'Extension failed to load — API continuing without it',
    {
      reason: result.reason,
      ...(result.message ? { message: result.message } : {}),
    }
  )
  await runAuditFanout(
    AuditEvent.EXTENSION_LOAD_FAILED,
    { reason: result.reason },
    listOrgIds,
    auditWriter,
    logger
  )
}

/**
 * Story 14.2: loads the single, founder-configured extension package at boot, fail-safe.
 * Never throws and never rejects — every failure path (import failure, manifest validation,
 * capability mismatch, a crash inside hooksFactory, or a hang/timeout) is caught and recorded
 * as module-level state instead, so a misconfigured extension can never crash `createApp()`.
 */
export async function loadExtension(
  packageName: string | undefined,
  deps: LoadExtensionDeps = {}
): Promise<void> {
  const {
    logger = silentLogger,
    importFn = defaultImportFn,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    listOrgIds = fetchAllOrgIds,
    auditWriter = defaultAuditWriter,
    allowApiVersionAboveHost = false,
  } = deps
  if (!packageName) return
  if (isDoubleInvocation(logger)) return

  const result = await raceWithTimeout(packageName, importFn, timeoutMs, allowApiVersionAboveHost)
  await applyOutcome(result, listOrgIds, auditWriter, logger, allowApiVersionAboveHost)
}
