/**
 * Story 23.2 AC-8a: break-glass, host-side, offline credential-recovery command.
 *
 * Usage:
 *   pnpm --filter @project-vault/api operator:recovery-link <email> [--yes-print-to-pipe]
 *
 * Mints a recovery link for an existing user using the SAME `recovery.ts` token machinery every
 * other recovery path uses (`createRecoveryToken`/`recoveryLinkUrl`, exported from recovery.ts
 * specifically for this reuse) and prints the one-time recovery URL to stdout only. There is no
 * route, no admin setting, and no org setting that invokes this — it is a CLI entry point,
 * reachable only by someone who can already execute in the API container/host
 * (`native-login-not-in-openapi.test.ts` asserts the OpenAPI spec references nothing of the kind).
 *
 * The gate (AC-8a item 3, second-pass revision after finding N4 — the first pass shipped a
 * backdoor by OR-ing in "native login is already enabled", which is true on the overwhelming
 * majority of existing deployments and would have made this a permanently available,
 * always-satisfied account-takeover primitive). The command refuses and exits non-zero unless
 * ALL THREE hold, read from the SAME boot-resolved policy state the API process itself uses
 * (`getNativeLoginPolicyState()`, resolved via the real `createApp()` boot path so an attacker
 * cannot satisfy (a) merely by exporting an env var in their own shell):
 *   (a) VAULT_NATIVE_LOGIN_BREAK_GLASS === true
 *   (b) replacementDeclared === true
 *   (c) replacementProven === true OR VAULT_NATIVE_LOGIN_REPLACEMENT_CONFIRMED === true
 * On an instance where native login is simply enabled, the command ALWAYS refuses.
 *
 * Auditability (AC-8a item 4): every invocation — minted or refused — writes a single,
 * fail-closed `platform_audit_events` row (NOT the per-org `audit_log_entries` fanout that
 * AC-8/AC-9's sibling events use — see the long comment on the matching constant in
 * platform-audit-actions.ts for why) with payload
 * `{ targetUserId, invokingOsUser, hostname, pid, outcome, refusalReason? }` — never free text,
 * never the email, never the token, never the URL. The audit write happens INSIDE the same
 * transaction as (and strictly before, in statement order) the token mint, so if the audit write
 * fails the whole transaction rolls back: nothing is minted, nothing is printed, and the command
 * exits non-zero. A `warn`-severity operational log line is also written on every invocation —
 * a refused invocation is exactly the signal an operator wants.
 *
 * `initiated_by` CHECK constraint (AC-8a item 5, finding N7): the row is written with
 * `initiatedBy: 'admin'` and BOTH `initiatorUserId` and `initiatorOrgId` NULL — a signature no
 * HTTP path produces (`sendAdminRecoveryLink()` always sets `initiatorOrgId`;
 * `issueNewOwnerRecoveryLink()` always sets it too). No schema change, no migration.
 *
 * See the comment on the platform-audit-actions constants file for why this writes into the
 * whole-instance platform audit table instead of the per-org fanout the sibling AC-8/AC-9
 * events use.
 */
import { hostname as osHostname, userInfo } from 'node:os'
import { eq } from 'drizzle-orm'
import { getDb } from '@project-vault/db'
import { users } from '@project-vault/db/schema'
import { OperationalEvent, PlatformAuditAction } from '@project-vault/shared'
import { createApp } from '../app.js'
import { getNativeLoginPolicyState } from '../modules/auth/native-login-policy.js'
import { createRecoveryToken, recoveryLinkUrl } from '../modules/auth/recovery.js'
import { writePlatformAuditEntryOrFailClosed } from '../lib/audit-or-fail-closed.js'
import { operationalLog } from '../lib/logger.js'

export type RefusalReason =
  'break_glass_off' | 'replacement_not_declared' | 'not_excluded' | 'user_not_found'

export type GateDecision = { allowed: true } | { allowed: false; reason: RefusalReason }

/**
 * AC-8a item 3: the three-way conjunction, evaluated in the order the refusalReason enum lists
 * them. Deliberately does NOT accept "native login is already enabled" as an alternative — that
 * clause was the finding-N4 backdoor and must not be reintroduced.
 */
export function evaluateBreakGlassGate(policy: {
  breakGlassActive: boolean
  replacementDeclared: boolean
  replacementProven: boolean
  replacementConfirmedOverride: boolean
}): GateDecision {
  if (!policy.breakGlassActive) return { allowed: false, reason: 'break_glass_off' }
  if (!policy.replacementDeclared) return { allowed: false, reason: 'replacement_not_declared' }
  if (!(policy.replacementProven || policy.replacementConfirmedOverride)) {
    return { allowed: false, reason: 'not_excluded' }
  }
  return { allowed: true }
}

function warn(eventType: string, message: string, fields?: Record<string, unknown>): void {
  operationalLog({ warn: () => undefined } as never, 'warn', eventType, message, fields)
}

/**
 * AC-8a item 4: a single fail-closed platform_audit_events write, run inside `tx`. Reused for
 * both the mint and refusal paths so the audit contract is identical either way. `operatorId`
 * (the platform_audit_events FK, NOT the `invokingOsUser` in the payload) is resolved to the
 * instance's platform operator — the one user row AC-6a's bootstrap guarantees always exists —
 * because there is no authenticated session actor for a host-side CLI invocation; the payload's
 * own `invokingOsUser`/`hostname`/`pid` fields are the actual forensic identity of who ran this.
 */
async function writeBreakGlassAuditRow(
  tx: Parameters<typeof writePlatformAuditEntryOrFailClosed>[0],
  input: {
    operatorId: string
    targetUserId: string | null
    outcome: 'minted' | 'refused'
    refusalReason?: RefusalReason
  }
): Promise<void> {
  await writePlatformAuditEntryOrFailClosed(tx, {
    operatorId: input.operatorId,
    actionType: PlatformAuditAction.NATIVE_LOGIN_BREAK_GLASS_RECOVERY_MINTED,
    targetUserId: input.targetUserId ?? undefined,
    payload: {
      targetUserId: input.targetUserId,
      invokingOsUser: userInfo().username,
      hostname: osHostname(),
      pid: process.pid,
      outcome: input.outcome,
      ...(input.refusalReason ? { refusalReason: input.refusalReason } : {}),
    },
  })
}

async function resolveAuditOperatorId(
  tx: Parameters<typeof writePlatformAuditEntryOrFailClosed>[0]
): Promise<string> {
  const [operator] = await tx
    .select({ id: users.id })
    .from(users)
    .where(eq(users.isPlatformOperator, true))
    .limit(1)
  if (!operator) {
    throw new Error(
      'operator:recovery-link: no platform operator row found — AC-6a guarantees the very first ' +
        'registered user is bootstrapped as the platform operator, so this indicates a corrupted ' +
        'instance, not a normal refusal path. Refusing to proceed.'
    )
  }
  return operator.id
}

export type RunResult =
  { outcome: 'minted'; url: string } | { outcome: 'refused'; reason: RefusalReason }

/**
 * The command's core logic, factored out from CLI-argument/stdout concerns so it can be unit
 * tested directly. `email` is the operator-supplied target; policy is read via
 * `getNativeLoginPolicyState()` by the caller's already-booted app.
 */
export async function runOperatorRecoveryLink(email: string): Promise<RunResult> {
  const policy = getNativeLoginPolicyState()
  const gate = evaluateBreakGlassGate(policy)

  return getDb().transaction(async (tx) => {
    const operatorId = await resolveAuditOperatorId(tx)

    if (!gate.allowed) {
      // Audit write happens first, in the transaction, before anything else — a failure here
      // rolls back the whole transaction and the caller reports non-zero with nothing printed.
      await writeBreakGlassAuditRow(tx, {
        operatorId,
        targetUserId: null,
        outcome: 'refused',
        refusalReason: gate.reason,
      })
      warn(
        OperationalEvent.NATIVE_LOGIN_BREAK_GLASS_RECOVERY_MINTED_LOG,
        'operator:recovery-link refused',
        { refusalReason: gate.reason }
      )
      return { outcome: 'refused', reason: gate.reason }
    }

    const [targetUser] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
      .limit(1)

    if (!targetUser) {
      await writeBreakGlassAuditRow(tx, {
        operatorId,
        targetUserId: null,
        outcome: 'refused',
        refusalReason: 'user_not_found',
      })
      warn(
        OperationalEvent.NATIVE_LOGIN_BREAK_GLASS_RECOVERY_MINTED_LOG,
        'operator:recovery-link refused',
        { refusalReason: 'user_not_found' }
      )
      return { outcome: 'refused', reason: 'user_not_found' }
    }

    // Audit write BEFORE the mint, same transaction — statement order matters (AC-8a item 4).
    await writeBreakGlassAuditRow(tx, {
      operatorId,
      targetUserId: targetUser.id,
      outcome: 'minted',
    })

    // AC-8a item 5: no HTTP path ever produces initiatedBy 'admin' with both initiator fields
    // null — this is the unambiguous, no-migration-needed break-glass signature.
    const { opaqueToken } = await createRecoveryToken(tx, {
      userId: targetUser.id,
      initiatedBy: 'admin',
    })

    warn(
      OperationalEvent.NATIVE_LOGIN_BREAK_GLASS_RECOVERY_MINTED_LOG,
      'operator:recovery-link minted a recovery link' +
        (targetUser.id === operatorId ? ' for the platform operator' : ''),
      { targetUserId: targetUser.id }
    )

    return { outcome: 'minted', url: recoveryLinkUrl(opaqueToken) }
  })
}

function parseArgs(argv: string[]): { email: string; yesPrintToPipe: boolean } {
  const yesPrintToPipe = argv.includes('--yes-print-to-pipe')
  const email = argv.find((arg) => !arg.startsWith('--'))
  if (!email) {
    throw new Error('Usage: operator:recovery-link <email> [--yes-print-to-pipe]')
  }
  return { email, yesPrintToPipe }
}

export async function main(argv: string[]): Promise<void> {
  const { email, yesPrintToPipe } = parseArgs(argv)

  // AC-8a item 4: refuse a non-TTY stdout without the explicit opt-in flag, so the URL is never
  // silently captured into a CI log by accident. Checked before anything else — including before
  // booting the app — so a misuse of this command never even touches the database.
  if (!process.stdout.isTTY && !yesPrintToPipe) {
    process.stderr.write(
      'operator:recovery-link: stdout is not a TTY. Re-run with --yes-print-to-pipe if you ' +
        'really intend to pipe/redirect the printed recovery URL.\n'
    )
    process.exitCode = 1
    return
  }

  // Boots through the SAME code path production uses (createApp -> resolveNativeLoginPolicy),
  // never re-derives the policy independently — AC-8a's gate is explicit that this must be the
  // process's actual boot-resolved state, not a value re-computed from raw env vars in the CLI.
  const app = await createApp({ logger: false })
  try {
    const result = await runOperatorRecoveryLink(email)
    if (result.outcome === 'refused') {
      const message =
        result.reason === 'user_not_found'
          ? `operator:recovery-link: no user found for ${email}.\n`
          : 'operator:recovery-link: this instance is not in a native-login-excluded state; ' +
            'use the ordinary recovery flow.\n'
      process.stderr.write(message)
      process.exitCode = 1
      return
    }
    process.stdout.write(`${result.url}\n`)
  } finally {
    await app.close()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    await main(process.argv.slice(2))
  } catch (error: unknown) {
    process.stderr.write(
      `operator:recovery-link failed: ${error instanceof Error ? error.stack : String(error)}\n`
    )
    process.exitCode = 1
  }
}
