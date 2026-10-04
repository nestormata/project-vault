import { randomUUID } from 'node:crypto'
import { and, eq, inArray } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { getDb, withOrg } from '@project-vault/db'
import { delegationAssertionJti } from '@project-vault/db/schema'
import { withTwoTestOrgs } from '@project-vault/db/test-helpers'
import {
  burnDelegationAssertion,
  classifyDelegationBurnError,
  type DelegationBurnOutcome,
} from './delegation-replay-store.js'

const nowSeconds = (): number => Math.floor(Date.now() / 1000)

function burnFor(orgId: string, jti: string): Promise<DelegationBurnOutcome> {
  return burnDelegationAssertion({
    orgId,
    jti,
    kid: 'cm-deleg-2026-10',
    assertionExpiresAtSeconds: nowSeconds() + 45,
  })
}

function tally(outcomes: DelegationBurnOutcome[]) {
  const count = (outcome: DelegationBurnOutcome['outcome']) =>
    outcomes.filter((result) => result.outcome === outcome).length
  return {
    burned: count('burned'),
    replayed: count('replayed'),
    store_unavailable: count('store_unavailable'),
  }
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected the statement to be rejected')
}

// Story 71.7 AC-4: the (org_id, jti) primary key is the atomic test-and-set. Racing burns go
// through independent pooled connections (Promise.all over real calls, never sequential awaits).
describe('delegation burn concurrency (Story 71.7 AC-4, real Postgres)', () => {
  it('a racing pair splits exactly one burned / one replayed, one row', async () => {
    await withTwoTestOrgs(async ({ orgAId }) => {
      const results = await Promise.all([
        burnFor(orgAId, 'race-pair'),
        burnFor(orgAId, 'race-pair'),
      ])
      expect(tally(results)).toEqual({ burned: 1, replayed: 1, store_unavailable: 0 })
      const rows = await withOrg(orgAId, (tx) =>
        tx
          .select()
          .from(delegationAssertionJti)
          .where(
            and(
              eq(delegationAssertionJti.orgId, orgAId),
              eq(delegationAssertionJti.jti, 'race-pair')
            )
          )
      )
      expect(rows).toHaveLength(1)
    })
  })

  it('25 concurrent racing pairs each split 1/1', async () => {
    await withTwoTestOrgs(async ({ orgAId }) => {
      const jtis = Array.from({ length: 25 }, () => `race-${randomUUID()}`)
      const pairs = await Promise.all(
        jtis.map((jti) => Promise.all([burnFor(orgAId, jti), burnFor(orgAId, jti)]))
      )
      for (const pair of pairs) {
        expect(tally(pair)).toEqual({ burned: 1, replayed: 1, store_unavailable: 0 })
      }
      const rows = await withOrg(orgAId, (tx) =>
        tx
          .select({ jti: delegationAssertionJti.jti })
          .from(delegationAssertionJti)
          .where(inArray(delegationAssertionJti.jti, jtis))
      )
      expect(rows).toHaveLength(25)
    })
  })

  it('N = 8 concurrent burns of one jti yield exactly 1 burned and 7 replayed', async () => {
    await withTwoTestOrgs(async ({ orgAId }) => {
      const results = await Promise.all(Array.from({ length: 8 }, () => burnFor(orgAId, 'race-8')))
      expect(tally(results)).toEqual({ burned: 1, replayed: 7, store_unavailable: 0 })
    })
  })
})

// Story 71.7 AC-5: FORCE RLS isolates burns per org.
describe('delegation burn tenant isolation (Story 71.7 AC-5, real Postgres)', () => {
  it('AC-5.1: a burn for B is invisible under A and visible under B', async () => {
    await withTwoTestOrgs(async ({ orgAId, orgBId }) => {
      await expect(burnFor(orgBId, 'iso-1')).resolves.toEqual({ outcome: 'burned' })
      const seenByA = await withOrg(orgAId, (tx) => tx.select().from(delegationAssertionJti))
      expect(seenByA).toHaveLength(0)
      const seenByB = await withOrg(orgBId, (tx) => tx.select().from(delegationAssertionJti))
      expect(seenByB.map((row) => row.jti)).toEqual(['iso-1'])
    })
  })

  it('AC-5.2: under A, a row carrying B fails WITH CHECK (42501) and classifies fail-closed', async () => {
    await withTwoTestOrgs(async ({ orgAId, orgBId }) => {
      const error = await rejectionOf(
        withOrg(orgAId, (tx) =>
          tx.insert(delegationAssertionJti).values({
            orgId: orgBId,
            jti: 'iso-cross',
            kid: 'k1',
            expiresAt: new Date(Date.now() + 60_000),
          })
        )
      )
      expect(classifyDelegationBurnError(error)).toEqual({
        outcome: 'store_unavailable',
        sqlState: '42501',
      })
    })
  })

  it('AC-5.3: the same jti burns independently for A and for B', async () => {
    await withTwoTestOrgs(async ({ orgAId, orgBId }) => {
      await expect(burnFor(orgAId, 'iso-shared')).resolves.toEqual({ outcome: 'burned' })
      await expect(burnFor(orgBId, 'iso-shared')).resolves.toEqual({ outcome: 'burned' })
    })
  })

  it('AC-5.4: without an org context SELECT sees nothing and INSERT fails', async () => {
    await withTwoTestOrgs(async ({ orgAId }) => {
      await expect(burnFor(orgAId, 'iso-no-ctx')).resolves.toEqual({ outcome: 'burned' })
      expect(await getDb().select().from(delegationAssertionJti)).toHaveLength(0)
      const error = await rejectionOf(
        getDb()
          .insert(delegationAssertionJti)
          .values({ orgId: orgAId, jti: 'iso-no-ctx-2', kid: 'k1', expiresAt: new Date() })
      )
      expect(classifyDelegationBurnError(error).outcome).toBe('store_unavailable')
    })
  })
})
