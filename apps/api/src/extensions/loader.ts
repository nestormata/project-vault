import type { FastifyBaseLogger } from 'fastify'
import { sql } from 'drizzle-orm'
import {
  getDb,
  getExtensionDbHandle,
  getExtensionDbPoolMax,
  hashExtensionDbScope,
  withOrg,
} from '@project-vault/db'
import { AuditEvent, OperationalEvent } from '@project-vault/shared'
import {
  EXTENSION_API_VERSION,
  ExtensionRegistrationError,
  isExtensionApiVersionSupported,
  registerExtension,
} from '@project-vault/extension-api'
import type {
  ExtensionHooks,
  ExtensionManifest,
  ExtensionRuntimeContext,
  HostServices,
} from '@project-vault/extension-api'
import { operationalLog } from '../lib/logger.js'
import { raceWithTimeout as sharedRaceWithTimeout } from '../lib/race-with-timeout.js'
import { writeSystemAuditRow } from '../lib/system-audit-row.js'
import { writeExtensionAuditEventForManifest } from '../lib/audit-event-source.js'
import { checkOrgAuthorization } from '../lib/org-authorization.js'
import { writePlatformAuditEntryOrFailClosed } from '../lib/audit-or-fail-closed.js'
import { fetchAllOrgIds } from '../middleware/rls.js'
import type { Tx } from '@project-vault/db'

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
  default: { manifest: ExtensionManifest; hooksFactory: (host: HostServices) => ExtensionHooks }
}

type ExtensionDbScopeStatus = 'not_configured' | 'declared_unapproved' | 'approved' | 'drift'

type ExtensionDbScopeSnapshot = {
  status: ExtensionDbScopeStatus
  declaredScope: ExtensionManifest['dbScope']
  approvedScope?: unknown
  overrideRationales?: unknown
  toolOwnedGrants?: unknown
  reason?: 'approval_read_failed' | 'missing_approval' | 'manifest_drift'
}

async function readExtensionDbScopeSnapshot(
  manifest: ExtensionManifest
): Promise<ExtensionDbScopeSnapshot> {
  const declaredScope = manifest.dbScope
  if (declaredScope === undefined || declaredScope.length === 0) {
    return { status: 'not_configured', declaredScope }
  }

  try {
    const rows = (await getDb().execute(sql`
      SELECT manifest_scope_hash, approved_scope, override_rationales, tool_owned_grants
        FROM extension_db_scope_approvals
       WHERE extension_name = ${manifest.name}
    `)) as unknown as Array<{
      manifest_scope_hash: string
      approved_scope: unknown
      override_rationales: unknown
      tool_owned_grants: unknown
    }>
    const approval = rows[0]
    if (!approval) {
      return { status: 'declared_unapproved', declaredScope, reason: 'missing_approval' }
    }
    const status =
      approval.manifest_scope_hash === hashExtensionDbScope(declaredScope) ? 'approved' : 'drift'
    return {
      status,
      declaredScope,
      approvedScope: approval.approved_scope,
      overrideRationales: approval.override_rationales,
      toolOwnedGrants: approval.tool_owned_grants,
      ...(status === 'drift' ? { reason: 'manifest_drift' as const } : {}),
    }
  } catch {
    return { status: 'declared_unapproved', declaredScope, reason: 'approval_read_failed' }
  }
}

async function readExtensionDbScopeStatus(
  manifest: ExtensionManifest
): Promise<ExtensionDbScopeSnapshot['status']> {
  return (await readExtensionDbScopeSnapshot(manifest)).status
}

function extensionDbScopeAuditDetails(snapshot: ExtensionDbScopeSnapshot): Record<string, unknown> {
  return {
    declaredScope: snapshot.declaredScope,
    ...(snapshot.approvedScope !== undefined ? { approvedScope: snapshot.approvedScope } : {}),
    ...(snapshot.overrideRationales !== undefined
      ? { overrideRationales: snapshot.overrideRationales }
      : {}),
    ...(snapshot.toolOwnedGrants !== undefined
      ? { toolOwnedGrants: snapshot.toolOwnedGrants }
      : {}),
    ...(snapshot.reason ? { reason: snapshot.reason } : {}),
  }
}

function logExtensionDbScopeStatus(logger: LoaderLogger, snapshot: ExtensionDbScopeSnapshot): void {
  if (snapshot.status === 'not_configured') return
  operationalLog(
    logger,
    snapshot.status === 'approved' ? 'info' : 'warn',
    'extension.db_scope.status',
    `extension DB scope status: ${snapshot.status}`,
    extensionDbScopeAuditDetails(snapshot)
  )
}

async function writeExtensionDbScopePlatformAudit(
  logger: LoaderLogger,
  snapshot: ExtensionDbScopeSnapshot
): Promise<void> {
  if (snapshot.status === 'not_configured') return

  try {
    await getDb().transaction(async (tx) => {
      const operators = (await tx.execute(sql`
        SELECT id
          FROM users
         WHERE is_platform_operator = true
         ORDER BY created_at ASC
         LIMIT 1
      `)) as unknown as Array<{ id: string }>
      const operatorId = operators[0]?.id
      if (!operatorId) {
        operationalLog(
          logger,
          'warn',
          'extension.db_scope.audit_skipped',
          'extension DB scope platform audit skipped because no platform operator exists',
          { status: snapshot.status }
        )
        return
      }

      await writePlatformAuditEntryOrFailClosed(tx as unknown as Tx, {
        operatorId,
        actionType: 'extension.db_scope.status',
        payload: {
          status: snapshot.status,
          ...extensionDbScopeAuditDetails(snapshot),
        },
      })
    })
  } catch {
    operationalLog(
      logger,
      'warn',
      'extension.db_scope.audit_failed',
      'extension DB scope platform audit could not be written',
      { status: snapshot.status, reason: 'write_failed' }
    )
  }
}

async function logExtensionDbPoolSizing(logger: LoaderLogger): Promise<void> {
  try {
    const rows = (await getDb().execute(sql`SHOW max_connections`)) as unknown as Array<{
      max_connections: string
    }>
    const maxConnections = Number(rows[0]?.max_connections)
    const extensionPoolMax = getExtensionDbPoolMax()
    const aggregatePoolMax = extensionPoolMax + 10 + 10
    operationalLog(
      logger,
      aggregatePoolMax > maxConnections ? 'warn' : 'info',
      'extension.db_pool.sizing',
      'extension DB pool sizing evaluated',
      {
        extensionPoolMax,
        corePoolMax: 10,
        adminPoolMax: 10,
        aggregatePoolMax,
        maxConnections,
        overSubscribed: aggregatePoolMax > maxConnections,
      }
    )
  } catch {
    operationalLog(
      logger,
      'warn',
      'extension.db_pool.sizing',
      'extension DB pool sizing could not be evaluated',
      { extensionPoolMax: getExtensionDbPoolMax(), corePoolMax: 10, adminPoolMax: 10 }
    )
  }
}

/**
 * Story 23.8 AC-6 — constructs the real `HostServices` object, bound to the loading extension's
 * own manifest, before `registerExtension()` calls `hooksFactory(host)`. Edge case: when no
 * extension is loaded (`state.status !== 'loaded'`), nothing ever calls
 * `writeExtensionAuditEventForManifest` — there is no global/ambient `host.auditEventSource`
 * reachable from anywhere outside the one `hooksFactory(host)` call for the one loaded extension
 * this process ever has (single-extension-per-process invariant, same as
 * `registeredGate`/`registeredGateName` in `lib/capability-gate.ts`).
 */
async function buildHostServices(
  manifest: ExtensionManifest
): Promise<ExtensionRuntimeContext & HostServices> {
  const scopeStatus = await readExtensionDbScopeStatus(manifest)
  return {
    auditEventSource: {
      writeAuditEvent: (input) => writeExtensionAuditEventForManifest(manifest, input),
    },
    // Story 23.9 AC1/Task 2: bound once at extension-load time, same as auditEventSource above.
    // Safe to reuse across requests — organizationId/viewerIdentityId are explicit call params
    // (never resolved ambiently), and checkOrgAuthorization() itself never caches (AC5).
    orgAuthorization: {
      checkMembership: (context) => checkOrgAuthorization(context),
    },
    getDbHandle: async () => {
      if (!manifest.dbScope || manifest.dbScope.length === 0) {
        return { unavailable: 'no-approved-scope' }
      }
      if (scopeStatus !== 'approved') return { unavailable: 'no-approved-scope' }
      const handle = getExtensionDbHandle()
      return handle ?? { unavailable: 'not-configured' }
    },
  }
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

/** Test-only direct state injection — never called from production code. Lets a test exercise
 * status.ts's AC-24 auditEventSource-observability branch without driving a full loadExtension()
 * import cycle. */
export function __setExtensionStateForTests(newState: ExtensionState): void {
  state = newState
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
 * timeout, via the shared `raceWithTimeout()` primitive (`lib/race-with-timeout.ts`) also used by
 * `lib/capability-gate.ts`'s gate invocation. A timeout maps to `'import_error'` — the closest
 * semantic fit — rather than inventing a 4th failure reason not sanctioned by epics.md's literal
 * AC text (Dev Notes judgment call #2).
 */
async function raceWithTimeout(
  packageName: string,
  importFn: ImportFn,
  timeoutMs: number,
  allowApiVersionAboveHost: boolean
): Promise<RaceResult> {
  const raced = await sharedRaceWithTimeout<LoadOutcome>(async () => {
    const mod = await importFn(packageName)
    return registerExtension(
      mod.default.manifest,
      mod.default.hooksFactory,
      { allowApiVersionAboveHost },
      await buildHostServices(mod.default.manifest)
    )
  }, timeoutMs)

  if (raced.status === 'resolved') return { outcome: raced.value, reason: 'import_error' }
  if (raced.status === 'timed_out') return { reason: 'import_error' }
  const error = raced.error
  return {
    reason: mapFailureReason(error),
    message: error instanceof ExtensionRegistrationError ? error.message.slice(0, 320) : undefined,
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
    const dbScopeSnapshot = await readExtensionDbScopeSnapshot(manifest)
    logExtensionDbScopeStatus(logger, dbScopeSnapshot)
    await writeExtensionDbScopePlatformAudit(logger, dbScopeSnapshot)
    if (dbScopeSnapshot.status === 'approved') await logExtensionDbPoolSizing(logger)
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
