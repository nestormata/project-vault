import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import postgres from 'postgres'
import { and, eq, sql } from 'drizzle-orm'
import { afterAll, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { getDb, withOrg, type Tx } from '@project-vault/db'
import { delegationAssertionJti } from '@project-vault/db/schema'
import { withTwoTestOrgs } from '@project-vault/db/test-helpers'
import {
  DELEGATION_BURN_OUTCOMES,
  DELEGATION_BURN_SKEW_SECONDS,
  DelegationBurnInputError,
  burnDelegationAssertion,
  classifyDelegationBurnError,
  createDelegationReplayStore,
  type DelegationBurnInput,
  type DelegationBurnOutcome,
  type OrgTransactionRunner,
} from './delegation-replay-store.js'

const SENTINEL_JTI = 'SENTINEL_JTI_7f3a'
const SENTINEL_KID = 'SENTINEL_KID_9c2e'
const PK_NAME = 'delegation_assertion_jti_org_id_jti_pk'
const ORG = randomUUID()
const KID = 'cm-deleg-2026-10'
const FIXED_NOW_MS = Date.UTC(2026, 9, 3, 12, 0, 0)
const FIXED_NOW_S = FIXED_NOW_MS / 1000

const nowSeconds = (): number => Math.floor(Date.now() / 1000)

function validInput(overrides: Partial<DelegationBurnInput> = {}): DelegationBurnInput {
  return {
    orgId: ORG,
    jti: 'j-unit',
    kid: KID,
    assertionExpiresAtSeconds: FIXED_NOW_S + 45,
    ...overrides,
  }
}

type RecordedInsert = { orgId: string; values: unknown; executed: number }

/** A runner that never touches the DB: records the org it was given and the inserted values. */
function recordingRunner(record: RecordedInsert[]) {
  return vi.fn<OrgTransactionRunner>(async (orgId, fn) => {
    const entry: RecordedInsert = { orgId, values: undefined, executed: 0 }
    record.push(entry)
    const fakeTx = {
      execute: async () => {
        entry.executed += 1
        return []
      },
      insert: () => ({
        values: async (values: unknown) => {
          entry.values = values
          return []
        },
      }),
    }
    return fn(fakeTx as unknown as Tx)
  })
}

function failingRunner(error: unknown) {
  return vi.fn<OrgTransactionRunner>(async () => {
    throw error
  })
}

async function burnRows(orgId: string, jti: string) {
  return withOrg(orgId, (tx) =>
    tx
      .select()
      .from(delegationAssertionJti)
      .where(and(eq(delegationAssertionJti.orgId, orgId), eq(delegationAssertionJti.jti, jti)))
  )
}

describe('burnDelegationAssertion contract (Story 71.7 AC-3, unit)', () => {
  it('exposes the closed outcome vocabulary and the skew constant', () => {
    expect(DELEGATION_BURN_OUTCOMES).toEqual(['burned', 'replayed', 'store_unavailable'])
    expect(DELEGATION_BURN_SKEW_SECONDS).toBe(30)
  })

  it('takes exactly one input object and no transaction (structural independence)', () => {
    expectTypeOf(burnDelegationAssertion).parameters.toEqualTypeOf<[DelegationBurnInput]>()
    expectTypeOf(burnDelegationAssertion).returns.toEqualTypeOf<Promise<DelegationBurnOutcome>>()
    expect(burnDelegationAssertion).toHaveLength(1)
  })

  it('feeds the single orgId to both the org runner and the inserted row', async () => {
    const record: RecordedInsert[] = []
    const store = createDelegationReplayStore({
      runInOrg: recordingRunner(record),
      now: () => FIXED_NOW_MS,
    })
    await expect(store.burn(validInput())).resolves.toEqual({ outcome: 'burned' })
    expect(record).toHaveLength(1)
    expect(record[0]?.orgId).toBe(ORG)
    expect(record[0]?.values).toEqual({
      orgId: ORG,
      jti: 'j-unit',
      kid: KID,
      expiresAt: new Date((FIXED_NOW_S + 45 + 30) * 1000),
    })
    // The statement/lock timeout is set inside the burn transaction before the insert (D9).
    expect(record[0]?.executed).toBe(1)
  })

  it('returns frozen outcome objects', async () => {
    const store = createDelegationReplayStore({
      runInOrg: recordingRunner([]),
      now: () => FIXED_NOW_MS,
    })
    expect(Object.isFrozen(await store.burn(validInput()))).toBe(true)
    expect(Object.isFrozen(classifyDelegationBurnError({ code: '23505' }))).toBe(true)
    expect(Object.isFrozen(classifyDelegationBurnError(new Error('x')))).toBe(true)
  })

  describe('input validation throws DelegationBurnInputError before any DB call (D10)', () => {
    const rejected: Array<[string, Partial<DelegationBurnInput>, string]> = [
      ['a non-UUID orgId', { orgId: 'not-a-uuid' }, 'orgId'],
      ['an empty jti', { jti: '' }, 'jti'],
      ['a jti with a NUL byte', { jti: `a\u0000${SENTINEL_JTI}` }, 'jti'],
      ['a jti with a C1 control character', { jti: `a\u0085${SENTINEL_JTI}` }, 'jti'],
      // Review fix: the driver encodes a lone UTF-16 surrogate as U+FFFD, so two distinct jtis
      // ('a\uD800', 'a\uD801') would collide on one stored key and the second would be "replayed".
      ['a jti with a lone surrogate', { jti: `a\uD800${SENTINEL_JTI}` }, 'jti'],
      ['a kid with a lone surrogate', { kid: `${SENTINEL_KID}\uDC00` }, 'kid'],
      ['a 130-byte multibyte jti', { jti: 'é'.repeat(65) }, 'jti'],
      ['a 129-byte kid', { kid: 'k'.repeat(129) }, 'kid'],
      ['an empty kid', { kid: '' }, 'kid'],
      ['a kid with a control character', { kid: `${SENTINEL_KID}\n` }, 'kid'],
      ['a fractional exp', { assertionExpiresAtSeconds: 1.5 }, 'assertionExpiresAtSeconds'],
      ['a NaN exp', { assertionExpiresAtSeconds: Number.NaN }, 'assertionExpiresAtSeconds'],
      [
        'an infinite exp',
        { assertionExpiresAtSeconds: Number.POSITIVE_INFINITY },
        'assertionExpiresAtSeconds',
      ],
      ['a negative exp', { assertionExpiresAtSeconds: -1 }, 'assertionExpiresAtSeconds'],
      [
        'an exp beyond lifetime + skew + tolerance',
        { assertionExpiresAtSeconds: FIXED_NOW_S + 96 },
        'assertionExpiresAtSeconds',
      ],
    ]

    it.each(rejected)('%s', async (_label, overrides, field) => {
      const runner = recordingRunner([])
      const store = createDelegationReplayStore({ runInOrg: runner, now: () => FIXED_NOW_MS })
      const attempt = store.burn(validInput(overrides))
      await expect(attempt).rejects.toBeInstanceOf(DelegationBurnInputError)
      const error = (await attempt.catch((e: unknown) => e)) as Error
      expect(error.message).toContain(field)
      expect(error.message).not.toContain(SENTINEL_JTI)
      expect(error.message).not.toContain(SENTINEL_KID)
      expect(error.message).not.toContain('not-a-uuid')
      expect(error.name).toBe('DelegationBurnInputError')
      expect(runner).not.toHaveBeenCalled()
    })

    it.each([
      ['a non-string jti', { jti: 42 as unknown as string }],
      ['a non-string kid', { kid: null as unknown as string }],
      ['a non-string orgId', { orgId: undefined as unknown as string }],
      ['a non-number exp', { assertionExpiresAtSeconds: '1' as unknown as number }],
    ])('%s', async (_label, overrides) => {
      const runner = recordingRunner([])
      const store = createDelegationReplayStore({ runInOrg: runner, now: () => FIXED_NOW_MS })
      await expect(store.burn(validInput(overrides))).rejects.toBeInstanceOf(
        DelegationBurnInputError
      )
      expect(runner).not.toHaveBeenCalled()
    })

    it.each([
      ['a 128-byte multibyte jti', { jti: 'é'.repeat(64) }],
      ['a 128-byte kid', { kid: 'k'.repeat(128) }],
      ['a jti with a well-formed astral character (surrogate pair)', { jti: 'j-\u{1F511}' }],
      [
        'an exp exactly at lifetime + skew + tolerance',
        { assertionExpiresAtSeconds: FIXED_NOW_S + 95 },
      ],
      ['a past exp (burn still recorded)', { assertionExpiresAtSeconds: FIXED_NOW_S - 3600 }],
      ['an upper-case orgId', { orgId: ORG.toUpperCase() }],
    ])('accepts %s', async (_label, overrides) => {
      const runner = recordingRunner([])
      const store = createDelegationReplayStore({ runInOrg: runner, now: () => FIXED_NOW_MS })
      await expect(store.burn(validInput(overrides))).resolves.toEqual({ outcome: 'burned' })
      expect(runner).toHaveBeenCalledTimes(1)
    })
  })

  describe('fails closed on every DB failure (injected runner)', () => {
    it.each([
      ['a drizzle-wrapped connection failure', { cause: { code: '08006' } }, '08006'],
      ['a plain Error (pool exhausted)', new Error('boom'), null],
      ['a wrapped FK violation (org deleted)', { cause: { code: '23503' } }, '23503'],
      ['a wrapped RLS violation', { cause: { code: '42501' } }, '42501'],
      ['a wrapped statement timeout', { cause: { code: '57014' } }, '57014'],
      ['a wrapped lock timeout', { cause: { code: '55P03' } }, '55P03'],
      ['a driver error code that is not a SQLSTATE', { code: 'ECONNREFUSED' }, null],
      ['a malformed sqlState', { cause: { code: 'not a code' } }, null],
      ['null', null, null],
      ['undefined', undefined, null],
      ['a string', 'boom', null],
      [
        'a 23505 on another constraint',
        { cause: { code: '23505', constraint_name: 'some_other_idx' } },
        '23505',
      ],
    ])('%s -> store_unavailable', async (_label, thrown, sqlState) => {
      const store = createDelegationReplayStore({
        runInOrg: failingRunner(thrown),
        now: () => FIXED_NOW_MS,
      })
      await expect(store.burn(validInput())).resolves.toEqual({
        outcome: 'store_unavailable',
        sqlState,
      })
    })

    it.each([
      ['a raw postgres-js unique violation', { code: '23505' }],
      ['a drizzle-wrapped unique violation', { cause: { code: '23505' } }],
      [
        'a unique violation on the burn primary key',
        { cause: { code: '23505', constraint_name: PK_NAME } },
      ],
    ])('%s -> replayed', async (_label, thrown) => {
      const store = createDelegationReplayStore({
        runInOrg: failingRunner(thrown),
        now: () => FIXED_NOW_MS,
      })
      await expect(store.burn(validInput())).resolves.toEqual({ outcome: 'replayed' })
    })
  })

  it('a cyclic cause chain without a code still resolves to store_unavailable', async () => {
    const cyclic: { cause?: unknown } = {}
    cyclic.cause = cyclic
    const store = createDelegationReplayStore({
      runInOrg: failingRunner(cyclic),
      now: () => FIXED_NOW_MS,
    })
    await expect(store.burn(validInput())).resolves.toEqual({
      outcome: 'store_unavailable',
      sqlState: null,
    })
  })

  it('never leaks the jti, kid, message or detail of an injected error (D13)', async () => {
    const injected = {
      cause: {
        code: '08006',
        message: SENTINEL_JTI,
        detail: `Key (org_id, jti)=(${ORG}, ${SENTINEL_JTI}) already exists`,
      },
    }
    const store = createDelegationReplayStore({
      runInOrg: failingRunner(injected),
      now: () => FIXED_NOW_MS,
    })
    const result = await store.burn(validInput({ jti: SENTINEL_JTI, kid: SENTINEL_KID }))
    expect(Object.keys(result).sort()).toEqual(['outcome', 'sqlState'])
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain(SENTINEL_JTI)
    expect(serialized).not.toContain(SENTINEL_KID)
    expect(serialized).not.toContain(ORG)
  })

  it('the module is insert-first, Map-free, logger-free and uses only withOrg', () => {
    const source = readFileSync(resolve(import.meta.dirname, 'delegation-replay-store.ts'), 'utf-8')
    expect(source).not.toMatch(/new Map\b/)
    expect(source).not.toMatch(/\.select\(/)
    expect(source).not.toMatch(/SELECT[^;`]*delegation_assertion_jti/i)
    expect(source).not.toMatch(/\bgetAdminDb\b|\bgetDb\b/)
    expect(source).not.toMatch(/logger|console\./i)
    expect(source).toMatch(/import \{[^}]*\bwithOrg\b[^}]*\} from '@project-vault\/db'/)
  })
})

describe('burnDelegationAssertion against real Postgres (Story 71.7 AC-3, AC-7.2)', () => {
  const holderSql = postgres(process.env['DATABASE_URL'] ?? '', { max: 1 })

  afterAll(async () => {
    await holderSql.end()
  })

  it('burns once, then reports the replay; still exactly one row with the skewed expiry', async () => {
    await withTwoTestOrgs(async ({ orgAId }) => {
      const exp = nowSeconds() + 45
      const input = {
        orgId: orgAId,
        jti: 'j-1',
        kid: KID,
        assertionExpiresAtSeconds: exp,
      }
      await expect(burnDelegationAssertion(input)).resolves.toEqual({ outcome: 'burned' })
      const rows = await burnRows(orgAId, 'j-1')
      expect(rows).toHaveLength(1)
      expect(rows[0]?.kid).toBe(KID)
      expect(rows[0]?.expiresAt.getTime()).toBe((exp + DELEGATION_BURN_SKEW_SECONDS) * 1000)

      await expect(burnDelegationAssertion(input)).resolves.toEqual({ outcome: 'replayed' })
      expect(await burnRows(orgAId, 'j-1')).toHaveLength(1)
    })
  })

  it('kid is not part of the key and the org id case does not matter', async () => {
    await withTwoTestOrgs(async ({ orgAId }) => {
      const exp = nowSeconds() + 30
      await expect(
        burnDelegationAssertion({
          orgId: orgAId,
          jti: 'j-kid',
          kid: 'k-one',
          assertionExpiresAtSeconds: exp,
        })
      ).resolves.toEqual({ outcome: 'burned' })
      await expect(
        burnDelegationAssertion({
          orgId: orgAId,
          jti: 'j-kid',
          kid: 'k-two',
          assertionExpiresAtSeconds: exp,
        })
      ).resolves.toEqual({ outcome: 'replayed' })
      await expect(
        burnDelegationAssertion({
          orgId: orgAId.toUpperCase(),
          jti: 'j-kid',
          kid: 'k-one',
          assertionExpiresAtSeconds: exp,
        })
      ).resolves.toEqual({ outcome: 'replayed' })
    })
  })

  it('commits independently of a handler transaction that rolls back', async () => {
    await withTwoTestOrgs(async ({ orgAId }) => {
      const input = {
        orgId: orgAId,
        jti: 'j-indep',
        kid: 'k1',
        assertionExpiresAtSeconds: nowSeconds() + 45,
      }
      let inner: DelegationBurnOutcome | undefined
      await expect(
        withOrg(orgAId, async (tx) => {
          inner = await burnDelegationAssertion(input)
          await tx.execute(sql`SELECT 1`)
          throw new Error('handler failed')
        })
      ).rejects.toThrow('handler failed')
      expect(inner).toEqual({ outcome: 'burned' })
      expect(await burnRows(orgAId, 'j-indep')).toHaveLength(1)
    })
  })

  it('accepts a past exp and records the burn', async () => {
    await withTwoTestOrgs(async ({ orgAId }) => {
      const input = {
        orgId: orgAId,
        jti: 'j-past',
        kid: 'k1',
        assertionExpiresAtSeconds: nowSeconds() - 3600,
      }
      await expect(burnDelegationAssertion(input)).resolves.toEqual({ outcome: 'burned' })
      expect(await burnRows(orgAId, 'j-past')).toHaveLength(1)
    })
  })

  it('times out to store_unavailable when the same key is held by an uncommitted insert (D9)', async () => {
    await withTwoTestOrgs(async ({ orgAId }) => {
      const exp = nowSeconds() + 45
      let outcome: DelegationBurnOutcome | undefined
      let elapsedMs = 0
      await holderSql
        .begin(async (tx) => {
          await tx`SELECT set_config('app.current_org_id', ${orgAId}, true)`
          await tx`INSERT INTO delegation_assertion_jti (org_id, jti, kid, expires_at)
                   VALUES (${orgAId}, 'j-lock', 'k1', now() + interval '1 minute')`
          const started = Date.now()
          outcome = await burnDelegationAssertion({
            orgId: orgAId,
            jti: 'j-lock',
            kid: 'k1',
            assertionExpiresAtSeconds: exp,
          })
          elapsedMs = Date.now() - started
          throw new Error('roll back the holder')
        })
        .catch((error: unknown) => {
          if (!(error instanceof Error) || error.message !== 'roll back the holder') throw error
        })
      expect(outcome?.outcome).toBe('store_unavailable')
      expect(['55P03', '57014']).toContain(
        (outcome as { sqlState: string | null } | undefined)?.sqlState
      )
      expect(elapsedMs).toBeGreaterThanOrEqual(1500)
      expect(elapsedMs).toBeLessThan(5000)
      // The holder rolled back, so the key is free again.
      await expect(
        burnDelegationAssertion({
          orgId: orgAId,
          jti: 'j-lock',
          kid: 'k1',
          assertionExpiresAtSeconds: exp,
        })
      ).resolves.toEqual({ outcome: 'burned' })
    })
  })

  // Review fix (AC-4 realism): Promise.all races may serialize through the pool, so this pins the
  // interleaving deterministically: the burn is observed WAITING on an uncommitted same-key insert,
  // the holder commits, and the waiter must resolve to `replayed` (never `burned`, never a timeout).
  it('a burn blocked on an uncommitted same-key insert resolves to replayed once the holder commits', async () => {
    await withTwoTestOrgs(async ({ orgAId }) => {
      const exp = nowSeconds() + 45
      let waiter: Promise<DelegationBurnOutcome> | undefined
      await holderSql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_org_id', ${orgAId}, true)`
        await tx`INSERT INTO delegation_assertion_jti (org_id, jti, kid, expires_at)
                 VALUES (${orgAId}, 'j-wait', 'k1', now() + interval '1 minute')`
        waiter = burnDelegationAssertion({
          orgId: orgAId,
          jti: 'j-wait',
          kid: 'k2',
          assertionExpiresAtSeconds: exp,
        })
        await vi.waitFor(
          async () => {
            const waiting = await getDb().execute<{ n: number }>(
              sql`SELECT count(*)::int AS n FROM pg_stat_activity
                   WHERE wait_event_type = 'Lock'
                     AND query ILIKE 'insert into "delegation_assertion_jti"%'`
            )
            expect(waiting[0]?.n).toBeGreaterThan(0)
          },
          { timeout: 1500, interval: 25 }
        )
      })
      await expect(waiter).resolves.toEqual({ outcome: 'replayed' })
      const rows = await burnRows(orgAId, 'j-wait')
      expect(rows).toHaveLength(1)
      expect(rows[0]?.kid).toBe('k1')
    })
  })

  it('AC-7.2: no outcome carries the jti, kid or org id', async () => {
    await withTwoTestOrgs(async ({ orgAId }) => {
      const input = {
        orgId: orgAId,
        jti: SENTINEL_JTI,
        kid: SENTINEL_KID,
        assertionExpiresAtSeconds: nowSeconds() + 45,
      }
      const burned = await burnDelegationAssertion(input)
      const replayed = await burnDelegationAssertion(input)
      const unavailable = await createDelegationReplayStore({
        runInOrg: failingRunner({ cause: { code: '08006', detail: SENTINEL_JTI } }),
      }).burn(input)
      expect([burned, replayed, unavailable].map((r) => r.outcome)).toEqual([
        'burned',
        'replayed',
        'store_unavailable',
      ])
      for (const result of [burned, replayed, unavailable]) {
        const serialized = JSON.stringify(result)
        expect(serialized).not.toContain(SENTINEL_JTI)
        expect(serialized).not.toContain(SENTINEL_KID)
        expect(serialized).not.toContain(orgAId)
      }
      expect(Object.keys(burned)).toEqual(['outcome'])
      expect(Object.keys(replayed)).toEqual(['outcome'])
    })
  })
})
