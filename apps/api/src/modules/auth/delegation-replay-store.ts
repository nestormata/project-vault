import { sql } from 'drizzle-orm'
import { withOrg, type Tx } from '@project-vault/db'
import { delegationAssertionJti } from '@project-vault/db/schema'

/**
 * Story 71.7 — durable, shared, org-isolated burn store for service-delegated actor assertions
 * (71-2 design note section 4.3, design check 12).
 *
 * Forward contract for Story 71-3 (secureRoute integration):
 * - Call `burnDelegationAssertion` once per request, AFTER org resolution (check 11, pass the
 *   RESOLVED PV org id, never the raw `org` claim) and BEFORE actor resolution (check 13), OUTSIDE
 *   (before) the handler transaction. The function opens and commits its own `withOrg`
 *   transaction; its type deliberately has no `tx` parameter. Never call it from inside another
 *   transaction.
 * - `jti` / `kid` / `assertionExpiresAtSeconds` are 71-6's `claims.jti` / `claims.kid` /
 *   `claims.expiresAt` (epoch SECONDS). The skew is applied here, in one place.
 * - Map `replayed` -> 409 `delegation_replayed`; `store_unavailable` -> 503
 *   `delegation_replay_store_unavailable` + `Retry-After`. A request rejected after `burned` is
 *   never retried with the same assertion: the sender mints a new one.
 * - `DelegationBurnInputError` is a contract violation by the caller (a PV bug): answer 500, not
 *   503.
 * - Log at most `outcome` and `sqlState`. Never log the input (threat 12).
 *
 * Semantics: insert-first, never select-then-insert; the `(org_id, jti)` primary key IS the
 * replay decision. Only a `23505` on that key is `replayed`; every other failure, of any kind, is
 * `store_unavailable` (fail closed; there is no in-process fallback). `burned` is returned only
 * after the transaction committed. The outcome never carries an identifier, an error message or
 * an error detail (a `23505` detail contains the key values).
 */

export const DELEGATION_BURN_SKEW_SECONDS = 30
export const DELEGATION_BURN_STATEMENT_TIMEOUT_MS = 2000
/** Assertion lifetime (design: `exp` at most 60 s after `iat`) + verifier skew + 5 s tolerance. */
const MAX_EXP_AHEAD_SECONDS = 60 + DELEGATION_BURN_SKEW_SECONDS + 5
const MAX_KEY_BYTES = 128
const BURN_PRIMARY_KEY = 'delegation_assertion_jti_org_id_jti_pk'
const UNIQUE_VIOLATION = '23505'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SQLSTATE_PATTERN = /^[0-9A-Z]{5}$/
// C0 controls (includes NUL), DEL and C1 controls.
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/
// A lone UTF-16 surrogate is not encodable: the driver writes it as U+FFFD, so two distinct
// values would collide on one stored key (a false `replayed`).
const LONE_SURROGATE = /\p{Cs}/u

export const DELEGATION_BURN_OUTCOMES = ['burned', 'replayed', 'store_unavailable'] as const

export type DelegationBurnInput = {
  /** The PV org id RESOLVED at check 11, never the raw `org` claim. */
  orgId: string
  /** `claims.jti` from 71-6. */
  jti: string
  /** `claims.kid` from 71-6 (a configured key id). */
  kid: string
  /** `claims.expiresAt` from 71-6 (epoch SECONDS). */
  assertionExpiresAtSeconds: number
}

export type DelegationBurnReplayed = { readonly outcome: 'replayed' }
export type DelegationBurnStoreUnavailable = {
  readonly outcome: 'store_unavailable'
  readonly sqlState: string | null
}
export type DelegationBurnOutcome =
  { readonly outcome: 'burned' } | DelegationBurnReplayed | DelegationBurnStoreUnavailable

/** A contract violation by the caller (D10), thrown before any DB call. Never names the value. */
export class DelegationBurnInputError extends Error {
  constructor(field: keyof DelegationBurnInput, rule: string) {
    super(`delegation burn input: ${field} ${rule}`)
    this.name = 'DelegationBurnInputError'
  }
}

const BURNED: DelegationBurnOutcome = Object.freeze({ outcome: 'burned' })
const REPLAYED: DelegationBurnReplayed = Object.freeze({ outcome: 'replayed' })

function storeUnavailable(sqlState: string | null): DelegationBurnStoreUnavailable {
  return Object.freeze({ outcome: 'store_unavailable', sqlState })
}

type PgErrorFields = { code: unknown; constraintName: unknown }

type ShapedPgError = { code?: unknown; constraint_name?: unknown; cause?: unknown }

function asShaped(value: unknown): ShapedPgError | undefined {
  return typeof value === 'object' && value !== null ? (value as ShapedPgError) : undefined
}

/**
 * Reads SQLSTATE + constraint from a raw postgres-js error (top level) or a drizzle-wrapped one
 * (`.cause`), exactly one level deep: no recursion, so a cyclic `.cause` chain cannot throw here.
 */
function pgErrorFields(error: unknown): PgErrorFields {
  const top = asShaped(error)
  const source = top?.code === undefined ? asShaped(top?.cause) : top
  return { code: source?.code, constraintName: source?.constraint_name }
}

/**
 * Pure classifier for any failure of the burn. `replayed` requires SQLSTATE `23505` on the burn
 * primary key (or a `23505` without a constraint name); everything else is `store_unavailable`
 * carrying at most a well-formed 5-character SQLSTATE.
 */
export function classifyDelegationBurnError(
  error: unknown
): DelegationBurnReplayed | DelegationBurnStoreUnavailable {
  const { code, constraintName } = pgErrorFields(error)
  const sqlState = typeof code === 'string' && SQLSTATE_PATTERN.test(code) ? code : null
  if (
    sqlState === UNIQUE_VIOLATION &&
    (constraintName === undefined || constraintName === BURN_PRIMARY_KEY)
  ) {
    return REPLAYED
  }
  return storeUnavailable(sqlState)
}

function assertKey(field: 'jti' | 'kid', value: unknown): void {
  if (typeof value !== 'string') throw new DelegationBurnInputError(field, 'must be a string')
  const bytes = Buffer.byteLength(value, 'utf8')
  if (bytes < 1 || bytes > MAX_KEY_BYTES) {
    throw new DelegationBurnInputError(field, `must be 1..${MAX_KEY_BYTES} UTF-8 bytes`)
  }
  if (CONTROL_CHARACTER.test(value)) {
    throw new DelegationBurnInputError(field, 'must not contain control characters')
  }
  if (LONE_SURROGATE.test(value)) {
    throw new DelegationBurnInputError(field, 'must be well-formed UTF-16 (no lone surrogate)')
  }
}

function assertInput(input: DelegationBurnInput, nowSeconds: number): void {
  if (typeof input.orgId !== 'string' || !UUID_PATTERN.test(input.orgId)) {
    throw new DelegationBurnInputError('orgId', 'must be a UUID')
  }
  assertKey('jti', input.jti)
  assertKey('kid', input.kid)
  const exp = input.assertionExpiresAtSeconds
  if (typeof exp !== 'number' || !Number.isSafeInteger(exp) || exp < 1) {
    throw new DelegationBurnInputError(
      'assertionExpiresAtSeconds',
      'must be a positive integer of epoch seconds'
    )
  }
  if (exp > nowSeconds + MAX_EXP_AHEAD_SECONDS) {
    throw new DelegationBurnInputError(
      'assertionExpiresAtSeconds',
      `must be at most ${MAX_EXP_AHEAD_SECONDS} s ahead of now`
    )
  }
}

/** Runs `fn` in its own transaction scoped to `orgId` (production: `withOrg`). */
export type OrgTransactionRunner = (orgId: string, fn: (tx: Tx) => Promise<void>) => Promise<void>

export type DelegationReplayStoreDeps = {
  runInOrg?: OrgTransactionRunner
  /** Clock in epoch milliseconds. */
  now?: () => number
  statementTimeoutMs?: number
}

export type DelegationReplayStore = {
  burn: (input: DelegationBurnInput) => Promise<DelegationBurnOutcome>
}

export function createDelegationReplayStore(
  deps: DelegationReplayStoreDeps = {}
): DelegationReplayStore {
  const runInOrg = deps.runInOrg ?? withOrg
  const now = deps.now ?? Date.now
  const timeout = String(deps.statementTimeoutMs ?? DELEGATION_BURN_STATEMENT_TIMEOUT_MS)

  async function burn(input: DelegationBurnInput): Promise<DelegationBurnOutcome> {
    assertInput(input, Math.floor(now() / 1000))
    const row = {
      orgId: input.orgId,
      jti: input.jti,
      kid: input.kid,
      expiresAt: new Date((input.assertionExpiresAtSeconds + DELEGATION_BURN_SKEW_SECONDS) * 1000),
    }
    try {
      await runInOrg(row.orgId, async (tx) => {
        // D9: bound a hung DB or a same-key insert held by another uncommitted transaction.
        await tx.execute(
          sql`SELECT set_config('statement_timeout', ${timeout}, true),
                     set_config('lock_timeout', ${timeout}, true)`
        )
        await tx.insert(delegationAssertionJti).values(row)
      })
    } catch (error) {
      return classifyDelegationBurnError(error)
    }
    return BURNED
  }

  return { burn }
}

const defaultStore = createDelegationReplayStore()

/** The production burn: real `withOrg`, real clock, fixed 2 s statement/lock timeout. */
export function burnDelegationAssertion(
  input: DelegationBurnInput
): Promise<DelegationBurnOutcome> {
  return defaultStore.burn(input)
}
