import type { FastifyBaseLogger, FastifyReply, FastifyRequest } from 'fastify'
import { withOrg } from '@project-vault/db'
import { AuditEvent, OperationalEvent } from '@project-vault/shared'
import { env } from '../../config/env.js'
import { DEV_AUTH_DUMMY_PASSWORD_HASH } from '../../config/dev-dummy-hash.js'
import { operationalLog } from '../../lib/logger.js'
import { writeSystemAuditRow } from '../../lib/system-audit-row.js'
import { fetchAllOrgIds } from '../../middleware/rls.js'
import type { ExtensionLoadFailureReason, ExtensionState } from '../../extensions/loader.js'
import {
  isLatchProvenForExtension,
  markDisabledAnnouncedIfFirst,
  readReplacementLatch,
  writeReplacementLatch,
} from './native-login-latch.js'
import { supersedeAllPriorRecoveryTokensForExclusion } from './recovery-lookup.js'

/**
 * Story 23.2 AC-4/AC-4a: native-login exclusion is resolved exactly once at boot, from
 * server-side state only, and is immutable for the process lifetime. There is no runtime
 * transition in either direction and no operator-facing runtime toggle — see the module-level
 * `policy` variable below, which is `Object.freeze()`d the moment it is set and never
 * reassigned except by the test-only reset.
 */
export type NativeLoginPolicyState =
  'enabled' | 'replacement_declared_unproven' | 'disabled' | 'break_glass'

export type NativeLoginPolicyDiagnostics = {
  enabled: boolean
  state: NativeLoginPolicyState
  replacementDeclared: boolean
  replacementProven: boolean
  replacementProvenAt: string | null
  appliedAtBoot: boolean
  breakGlassActive: boolean
  replacementConfirmedOverride: boolean
  extensionStatus: ExtensionState['status']
  extensionFailureReason: ExtensionLoadFailureReason | null
}

let policy: Readonly<NativeLoginPolicyDiagnostics> | undefined
let resolving: Promise<void> | undefined

// Story 23.2 fix (code review): the AC-4a/AC-7/AC-8 boot-time warn/fatal lines this module emits
// were being written to a `{ warn: () => undefined }` stub — a silent no-op — instead of the
// real Fastify logger `createApp()` already has in hand at the call site. Every operator-facing
// "loud warning" this story promises (NATIVE_LOGIN_REPLACEMENT_PENDING, the break-glass-active
// line, the dummy-hash-unsafe warning, the fail-safe fatal line) never actually appeared anywhere
// observable. `resolveNativeLoginPolicy()` now accepts the real logger and stores it here so the
// module-private `warn()` helper (and the AC-7 fatal fallback) can use it. Defaults to a no-op so
// existing tests that call `resolveNativeLoginPolicy(state)` without a logger keep passing.
let activeLogger: Partial<Pick<FastifyBaseLogger, 'info' | 'warn' | 'error' | 'fatal'>> = {}

/** The stable identity string used everywhere else in this module (AC-9 audit payloads) to name
 * the currently-loaded extension — `null` when nothing is loaded or loading failed. */
function currentExtensionName(state: ExtensionState): string | null {
  return state.status === 'loaded' ? state.manifest.name : null
}

function deriveReplacementDeclared(state: ExtensionState): boolean {
  // register-extension.ts already refuses to load an extension that declares
  // replacesNativeLogin: true without 'auth-provider' in capabilities[] or without an
  // authStrategy hook (AC-2) — so "loaded" + the manifest flag is sufficient here; re-checking
  // capabilities/hooks would duplicate a guarantee the loader already enforces.
  return state.status === 'loaded' && state.manifest.replacesNativeLogin === true
}

function computePolicy(
  replacementDeclared: boolean,
  replacementProven: boolean
): { enabled: boolean; state: NativeLoginPolicyState } {
  if (env.VAULT_NATIVE_LOGIN_BREAK_GLASS) return { enabled: true, state: 'break_glass' }
  if (!replacementDeclared) return { enabled: true, state: 'enabled' }
  const proven = replacementProven || env.VAULT_NATIVE_LOGIN_REPLACEMENT_CONFIRMED
  if (!proven) return { enabled: true, state: 'replacement_declared_unproven' }
  return { enabled: false, state: 'disabled' }
}

function warn(eventType: string, message: string, fields?: Record<string, unknown>): void {
  operationalLog(activeLogger, 'warn', eventType, message, fields)
}

async function fanoutAudit(eventType: string, payload: Record<string, unknown>): Promise<void> {
  let orgIds: string[]
  try {
    orgIds = await fetchAllOrgIds()
  } catch {
    warn(
      OperationalEvent.NATIVE_LOGIN_AUDIT_FANOUT_ROW_FAILED,
      'native-login audit fanout: failed to enumerate organizations'
    )
    return
  }
  for (const orgId of orgIds) {
    try {
      await withOrg(orgId, (tx) => writeSystemAuditRow(tx, { orgId, eventType, payload }))
    } catch {
      warn(
        OperationalEvent.NATIVE_LOGIN_AUDIT_FANOUT_ROW_FAILED,
        'native-login audit fanout: one org row failed to write',
        { orgId, eventType }
      )
    }
  }
}

async function logBootWarnings(
  policyState: NativeLoginPolicyState,
  replacementDeclared: boolean,
  state: ExtensionState
): Promise<void> {
  if (policyState === 'replacement_declared_unproven') {
    warn(
      OperationalEvent.NATIVE_LOGIN_REPLACEMENT_PENDING,
      'native login replacement declared but never proven — native login remains enabled'
    )
  }
  if (env.VAULT_NATIVE_LOGIN_REPLACEMENT_CONFIRMED) {
    warn(
      OperationalEvent.NATIVE_LOGIN_REPLACEMENT_CONFIRMED_OVERRIDE,
      'VAULT_NATIVE_LOGIN_REPLACEMENT_CONFIRMED is set — native login exclusion applied on the strength of the manifest declaration alone, skipping the proving latch'
    )
  }
  // AC-8/AC-16: the operational warning fires whenever break-glass is set, on every boot,
  // regardless of whether an extension is loaded. The audit fanout fires only when
  // replacementDeclared is also true, so a vanilla instance that sets the flag defensively
  // produces zero new audit rows (AC-16).
  if (env.VAULT_NATIVE_LOGIN_BREAK_GLASS) {
    warn(
      OperationalEvent.NATIVE_LOGIN_BREAK_GLASS_ACTIVE_LOG,
      'VAULT_NATIVE_LOGIN_BREAK_GLASS is set — the entire native-credential surface is re-enabled regardless of the loaded extension'
    )
    if (replacementDeclared) {
      await fanoutAudit(AuditEvent.NATIVE_LOGIN_BREAK_GLASS_ACTIVE, {
        extensionName: state.status === 'loaded' ? state.manifest.name : null,
      })
    }
  }
}

/**
 * Story 23.2 AC-6e item 3: a boot check scoped to this story's blast radius. The whole
 * exclusion story's safety premise (AC-8a, AC-6b, and the security-posture Dev Notes) is that
 * extension/SSO-provisioned users hold an UNUSABLE credential, so re-opening `POST /login` via
 * break-glass "recovers nobody and discloses nothing." That premise depends on
 * `env.AUTH_DUMMY_PASSWORD_HASH` never being stored as a real credential (AC-6e items 1-2) AND
 * never being left at its in-repo, publicly-known default on an instance where the policy is
 * anything other than plain 'enabled' — the exact set of instances whose safety depends on the
 * unusability claim being true. On every other instance (including every existing
 * extension-less production deployment) this only warns — making the var required in production
 * unconditionally would break existing deployments relying on the default and would violate
 * AC-16.
 */
function assertDummyPasswordHashSafe(policyState: NativeLoginPolicyState): void {
  if (env.AUTH_DUMMY_PASSWORD_HASH !== DEV_AUTH_DUMMY_PASSWORD_HASH) return

  warn(
    OperationalEvent.NATIVE_LOGIN_DUMMY_HASH_UNSAFE,
    'env.AUTH_DUMMY_PASSWORD_HASH is still the in-repo, publicly-known default value',
    { policyState }
  )

  if (policyState === 'enabled') return
  throw new Error(
    'AC-6e: env.AUTH_DUMMY_PASSWORD_HASH must not be left at its in-repo default ' +
      '(DEV_AUTH_DUMMY_PASSWORD_HASH) on an instance whose native-login policy is not plain ' +
      '"enabled" — set a unique AUTH_DUMMY_PASSWORD_HASH for this deployment before booting again.'
  )
}

async function announceDisabledTransitionIfFirst(state: ExtensionState): Promise<void> {
  // AC-9: written once per instance, on the transition into the disabled policy — never on
  // every subsequent boot in the disabled state, and never on a mid-process flip (there is
  // none). The atomic conditional UPDATE ensures exactly one process, across any number of
  // racing workers, performs the fanout.
  const isFirst = await markDisabledAnnouncedIfFirst()
  if (!isFirst) return
  await fanoutAudit(AuditEvent.NATIVE_LOGIN_DISABLED, {
    extensionName: state.status === 'loaded' ? state.manifest.name : null,
    apiVersion: state.status === 'loaded' ? state.manifest.apiVersion : null,
  })
}

/**
 * Story 23.2 AC-6 ("pre-staging is closed retroactively, not just prospectively"). Unlike
 * `announceDisabledTransitionIfFirst` above, this runs on EVERY boot whose resolved policy is
 * 'disabled' — not gated behind the "first boot only" latch — because the supersession UPDATE is
 * itself idempotent (an already-superseded row simply doesn't match the WHERE clause again) and
 * the story text says so explicitly. A failure here must never crash boot or block the policy
 * from resolving — worst case, some pre-staged tokens stay live for one more boot cycle, which is
 * strictly better than failing the whole instance's startup over a defense-in-depth sweep.
 */
async function supersedePreStagedRecoveryTokensIfDisabled(
  policyState: NativeLoginPolicyState
): Promise<void> {
  if (policyState !== 'disabled') return
  try {
    await supersedeAllPriorRecoveryTokensForExclusion()
  } catch {
    warn(
      OperationalEvent.NATIVE_LOGIN_RECOVERY_TOKEN_SUPERSESSION_FAILED,
      'failed to supersede pre-staged recovery tokens on a disabled boot — will retry next boot'
    )
  }
}

/**
 * Story 23.2 AC-4: called once from `createApp()`, immediately after
 * `wireExtensionAuthStrategy()`. Idempotent under double-invocation (the
 * `generate-spec.ts` / `route-audit.test.ts` pattern, mirroring `loadExtension()`'s own
 * double-invocation guard) — a second call in the same process is a silent no-op, never a
 * re-resolution.
 */
/**
 * Story 23.2 AC-7: resolveNativeLoginPolicy() itself must never be able to disable native login
 * via a bug in its OWN resolution logic (as opposed to an intentional refusal like AC-6e's
 * dummy-hash boot check below, which is deliberately allowed to throw and fail startup). Only the
 * derivation-and-freeze block is wrapped — a throw there resolves fail-safe to plain 'enabled'
 * with fatal logging instead of leaving `policy` unset (which would otherwise crash every
 * subsequent `isNativeLoginEnabled()`/`getNativeLoginPolicyState()` caller, i.e. every request).
 */
/** AC-7 fail-safe fallback: the frozen diagnostics object used when the try block below throws. */
function failSafeEnabledPolicy(state: ExtensionState): NativeLoginPolicyDiagnostics {
  return {
    enabled: true,
    state: 'enabled',
    replacementDeclared: false,
    replacementProven: false,
    replacementProvenAt: null,
    appliedAtBoot: true,
    breakGlassActive: env.VAULT_NATIVE_LOGIN_BREAK_GLASS,
    replacementConfirmedOverride: env.VAULT_NATIVE_LOGIN_REPLACEMENT_CONFIRMED,
    extensionStatus: state.status,
    extensionFailureReason: state.status === 'load_failed' ? state.reason : null,
  }
}

/** The core derivation — everything AC-7 requires to be wrapped in a fail-safe try/catch. */
async function resolveCorePolicy(
  state: ExtensionState
): Promise<{ policyState: NativeLoginPolicyState; replacementDeclared: boolean }> {
  const replacementDeclared = deriveReplacementDeclared(state)
  const latch = await readReplacementLatch()
  // Story 23.2 fix (code review): a latch proven by a DIFFERENT (or no longer loaded) extension
  // must never be inherited as proof for whatever is loaded now — see
  // isLatchProvenForExtension()'s doc comment.
  const replacementProven = isLatchProvenForExtension(latch, currentExtensionName(state))
  const computed = computePolicy(replacementDeclared, replacementProven)

  policy = Object.freeze({
    enabled: computed.enabled,
    state: computed.state,
    replacementDeclared,
    replacementProven,
    // Scoped to match: a provenAt timestamp that belongs to a different extension than the one
    // loaded now is not evidence about THIS extension, so it is not surfaced as this policy's
    // replacementProvenAt either — surfacing it would look like proof for the wrong thing.
    replacementProvenAt: replacementProven ? (latch?.replacementProvenAt ?? null) : null,
    appliedAtBoot: computed.state === 'disabled' || !(replacementDeclared && replacementProven),
    breakGlassActive: env.VAULT_NATIVE_LOGIN_BREAK_GLASS,
    replacementConfirmedOverride: env.VAULT_NATIVE_LOGIN_REPLACEMENT_CONFIRMED,
    extensionStatus: state.status,
    extensionFailureReason: state.status === 'load_failed' ? state.reason : null,
  })
  return { policyState: computed.state, replacementDeclared }
}

export async function resolveNativeLoginPolicy(
  state: ExtensionState,
  logger?: Partial<Pick<FastifyBaseLogger, 'info' | 'warn' | 'error' | 'fatal'>>
): Promise<void> {
  if (logger) activeLogger = logger
  if (policy) return
  if (resolving) return resolving
  resolving = (async () => {
    let resolved: { policyState: NativeLoginPolicyState; replacementDeclared: boolean }

    try {
      resolved = await resolveCorePolicy(state)
    } catch (error) {
      policy = Object.freeze(failSafeEnabledPolicy(state))
      operationalLog(
        activeLogger,
        'fatal',
        OperationalEvent.NATIVE_LOGIN_POLICY_RESOLUTION_FAILED,
        'resolveNativeLoginPolicy() threw while resolving — failing safe to native login enabled',
        { error: error instanceof Error ? error.message : String(error) }
      )
      return
    }

    const { policyState, replacementDeclared } = resolved
    assertDummyPasswordHashSafe(policyState)
    await logBootWarnings(policyState, replacementDeclared, state)
    await supersedePreStagedRecoveryTokensIfDisabled(policyState)
    if (policyState === 'disabled') await announceDisabledTransitionIfFirst(state)
  })()
  await resolving
}

/** Story 23.2 AC-4: throws if called before `resolveNativeLoginPolicy()` has resolved — a
 * caller bug, since `createApp()` always awaits resolution before returning to any caller. */
export function isNativeLoginEnabled(): boolean {
  if (!policy) throw new Error('native login policy has not been resolved yet')
  return policy.enabled
}

export function getNativeLoginPolicyState(): Readonly<NativeLoginPolicyDiagnostics> {
  if (!policy) throw new Error('native login policy has not been resolved yet')
  return policy
}

/**
 * Story 23.2 AC-4a: the proving latch writer. Called only from the SSO-callback success path,
 * after a session has been issued — never before, and never on a merely-parsed envelope. Writes
 * the persisted latch row (idempotent, `ON CONFLICT`-safe under concurrent first successes) and
 * NEVER touches the frozen in-process `policy` object — the latch applies only at the next boot
 * (AC-4/finding N3). A failed write never fails the login and never disables native login.
 *
 * Story 23.2 fix (code review): `extensionName` records WHICH strategy actually authenticated
 * someone — the caller (sso-routes.ts) passes the `providerName` this specific login
 * authenticated under, which equals the loaded extension's manifest `name` by construction
 * (`wireExtensionAuthStrategy()` in strategies.ts registers every extension-provided strategy
 * under `state.manifest.name`). A `null`/empty value is never written — there is nothing
 * meaningful to attribute the proof to, and writing an unattributed row would be
 * indistinguishable from a legacy pre-fix row, which `isLatchProvenForExtension()` already
 * treats as unproven.
 */
export async function markReplacementProven(extensionName: string | null): Promise<void> {
  if (!extensionName) return
  try {
    await writeReplacementLatch(extensionName)
  } catch {
    // Never propagate — a failed latch write must not fail the login that triggered it, and
    // will simply be retried on the next successful authentication.
  }
}

/** Test-only reset of module-level state — never called from production code. */
export function __resetNativeLoginPolicyForTests(): void {
  policy = undefined
  resolving = undefined
  activeLogger = {}
}

/**
 * Story 23.2 AC-5/AC-6: the single shared gate applied at the `preHandler` hook of every
 * native-credential route (strictly after `@fastify/rate-limit`'s `onRequest`). Rejects before
 * any credential is read, hashed, compared, or persisted. The policy is boot-resolved
 * server-side state only — nothing a request carries (header, body, query, cookie) can
 * influence it (AC-5).
 */
export function nativeCredentialGatePreHandler(
  _request: FastifyRequest,
  reply: FastifyReply
): FastifyReply | undefined {
  if (isNativeLoginEnabled()) return undefined
  operationalLog(
    _request.log ?? {},
    'info',
    OperationalEvent.NATIVE_LOGIN_REJECTED,
    'native-credential route rejected — native login is disabled on this instance',
    { route: _request.url, reason: 'native_login_disabled' }
  )
  return reply.status(403).send({
    code: 'native_login_disabled',
    message:
      'Native login is disabled on this vault. Sign in through your organization’s SSO provider.',
  })
}
