import type { FastifyReply, FastifyRequest } from 'fastify'
import { withOrg } from '@project-vault/db'
import { AuditEvent, OperationalEvent } from '@project-vault/shared'
import { env, DEV_AUTH_DUMMY_PASSWORD_HASH } from '../../config/env.js'
import { operationalLog } from '../../lib/logger.js'
import { writeSystemAuditRow } from '../../lib/system-audit-row.js'
import { fetchAllOrgIds } from '../../middleware/rls.js'
import type { ExtensionLoadFailureReason, ExtensionState } from '../../extensions/loader.js'
import {
  markDisabledAnnouncedIfFirst,
  readReplacementLatch,
  writeReplacementLatch,
} from './native-login-latch.js'

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
  operationalLog({ warn: () => undefined }, 'warn', eventType, message, fields)
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
 * Story 23.2 AC-4: called once from `createApp()`, immediately after
 * `wireExtensionAuthStrategy()`. Idempotent under double-invocation (the
 * `generate-spec.ts` / `route-audit.test.ts` pattern, mirroring `loadExtension()`'s own
 * double-invocation guard) — a second call in the same process is a silent no-op, never a
 * re-resolution.
 */
export async function resolveNativeLoginPolicy(state: ExtensionState): Promise<void> {
  if (policy) return
  if (resolving) return resolving
  resolving = (async () => {
    const replacementDeclared = deriveReplacementDeclared(state)
    const latch = await readReplacementLatch()
    const replacementProven = latch?.replacementProvenAt != null
    const { enabled, state: policyState } = computePolicy(replacementDeclared, replacementProven)

    const extensionStatus = state.status
    const extensionFailureReason = state.status === 'load_failed' ? state.reason : null

    policy = Object.freeze({
      enabled,
      state: policyState,
      replacementDeclared,
      replacementProven,
      replacementProvenAt: latch?.replacementProvenAt ?? null,
      appliedAtBoot: policyState === 'disabled' || !(replacementDeclared && replacementProven),
      breakGlassActive: env.VAULT_NATIVE_LOGIN_BREAK_GLASS,
      replacementConfirmedOverride: env.VAULT_NATIVE_LOGIN_REPLACEMENT_CONFIRMED,
      extensionStatus,
      extensionFailureReason,
    })

    assertDummyPasswordHashSafe(policyState)
    await logBootWarnings(policyState, replacementDeclared, state)
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
 */
export async function markReplacementProven(): Promise<void> {
  try {
    await writeReplacementLatch()
  } catch {
    // Never propagate — a failed latch write must not fail the login that triggered it, and
    // will simply be retried on the next successful authentication.
  }
}

/** Test-only reset of module-level state — never called from production code. */
export function __resetNativeLoginPolicyForTests(): void {
  policy = undefined
  resolving = undefined
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
    { info: () => undefined } as never,
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
