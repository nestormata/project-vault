import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { withOrg } from '@project-vault/db'
import { delegationAssertionJti } from '@project-vault/db/schema'
import { withTwoTestOrgs } from '@project-vault/db/test-helpers'
import {
  DELEGATION_BURN_SKEW_SECONDS,
  burnDelegationAssertion,
} from '../modules/auth/delegation-replay-store.js'
import {
  DELEGATION_JTI_PRUNE_BATCH_SIZE,
  DELEGATION_JTI_PRUNE_GRACE_SECONDS,
  DELEGATION_JTI_PRUNE_JOB,
  createDelegationJtiPruner,
  delegationJtiPruneCutoff,
  pruneDelegationAssertionJti,
} from './prune-delegation-assertion-jti.js'

// Every row these tests write expires in 2001, and every injected prune clock is in 2001, so a
// run can only ever reach rows written by this file (real burns expire around "now").
const BASE_2001_MS = Date.UTC(2001, 0, 1, 0, 0, 0)
const JOB = 'delegation/prune-assertion-jti'
const COMPLETED = 'job.completed'

function captureLogger() {
  return { info: vi.fn(), error: vi.fn() }
}

async function seed(orgId: string, rows: Array<{ jti: string; expiresAtMs: number }>) {
  await withOrg(orgId, (tx) =>
    tx.insert(delegationAssertionJti).values(
      rows.map((row) => ({
        orgId,
        jti: row.jti,
        kid: 'cm-deleg-2026-10',
        expiresAt: new Date(row.expiresAtMs),
      }))
    )
  )
}

async function remainingJtis(orgId: string): Promise<string[]> {
  const rows = await withOrg(orgId, (tx) =>
    tx.select({ jti: delegationAssertionJti.jti }).from(delegationAssertionJti)
  )
  return rows.map((row) => row.jti).sort()
}

describe('delegation/prune-assertion-jti constants and wiring (Story 71.7 AC-6)', () => {
  it('pins the job name, batch size and grace', () => {
    expect(DELEGATION_JTI_PRUNE_JOB).toBe(JOB)
    expect(DELEGATION_JTI_PRUNE_BATCH_SIZE).toBe(5000)
    expect(DELEGATION_JTI_PRUNE_GRACE_SECONDS).toBe(300)
  })

  it('the cutoff is the prune clock minus the grace', () => {
    expect(delegationJtiPruneCutoff(new Date(BASE_2001_MS)).getTime()).toBe(BASE_2001_MS - 300_000)
  })

  it('retention invariant I1: a row is never pruned while any verifier could still accept it', () => {
    const nowS = BASE_2001_MS / 1000
    const violations: string[] = []
    for (let exp = nowS - 120; exp <= nowS + 90; exp++) {
      const expiresAtMs = (exp + DELEGATION_BURN_SKEW_SECONDS) * 1000
      for (let offset = -240; offset <= 240; offset++) {
        const pruneClockS = nowS + offset
        const pruned =
          expiresAtMs < delegationJtiPruneCutoff(new Date(pruneClockS * 1000)).getTime()
        if (pruned && pruneClockS - DELEGATION_JTI_PRUNE_GRACE_SECONDS <= exp + 30) {
          violations.push(`exp=${exp} prune=${pruneClockS}`)
        }
      }
    }
    expect(violations).toEqual([])
  })

  it('the worker source has no loop around an await and no async map (S9382)', () => {
    const source = readFileSync(
      resolve(import.meta.dirname, 'prune-delegation-assertion-jti.ts'),
      'utf-8'
    )
    expect(source).not.toMatch(/\bfor\s*\(|\bwhile\s*\(/)
    expect(source).not.toMatch(/\.map\(\s*async/)
    expect(source).not.toMatch(/console\./)
  })

  it('logs job.failed and rethrows when the admin pool is unavailable', async () => {
    const logger = captureLogger()
    const failure = new Error('ADMIN_DATABASE_URL is required')
    const pruner = createDelegationJtiPruner({
      getDb: () => {
        throw failure
      },
    })
    await expect(pruner.prune(logger)).rejects.toBe(failure)
    expect(logger.error).toHaveBeenCalledWith({
      eventType: 'job.failed',
      jobName: JOB,
      err: failure,
    })
    expect(logger.info).not.toHaveBeenCalled()
  })

  it('the default export runs the production pruner (nothing expired in 2001-free data)', async () => {
    const logger = captureLogger()
    await expect(pruneDelegationAssertionJti(logger)).resolves.toBeUndefined()
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: COMPLETED, jobName: DELEGATION_JTI_PRUNE_JOB })
    )
    expect(logger.error).not.toHaveBeenCalled()
  })
})

describe('delegation/prune-assertion-jti against real Postgres (Story 71.7 AC-6, AC-7.2)', () => {
  it('deletes only rows past the grace, across orgs, and logs the count without identifiers', async () => {
    await withTwoTestOrgs(async ({ orgAId, orgBId }) => {
      const t = BASE_2001_MS
      await seed(orgAId, [
        { jti: 'old-a', expiresAtMs: t - 400_000 },
        { jti: 'in-grace-a', expiresAtMs: t - 100_000 },
      ])
      await seed(orgBId, [
        { jti: 'old-b', expiresAtMs: t - 400_000 },
        { jti: 'live-b', expiresAtMs: t + 90_000 },
      ])
      const logger = captureLogger()
      await createDelegationJtiPruner({ now: () => new Date(t) }).prune(logger)

      expect(await remainingJtis(orgAId)).toEqual(['in-grace-a'])
      expect(await remainingJtis(orgBId)).toEqual(['live-b'])
      expect(logger.info.mock.calls).toEqual([
        [
          {
            eventType: COMPLETED,
            jobName: JOB,
            deletedCount: 2,
          },
        ],
      ])
      const logged = JSON.stringify(logger.info.mock.calls)
      expect(logged).not.toContain(orgAId)
      expect(logged).not.toContain(orgBId)
      expect(logged).not.toContain('old-a')
    })
  })

  it('window: a burn at T with exp T+60 survives until T+390 and is pruned at T+391', async () => {
    await withTwoTestOrgs(async ({ orgAId }) => {
      const tS = BASE_2001_MS / 1000 + 86_400
      await expect(
        burnDelegationAssertion({
          orgId: orgAId,
          jti: 'SENTINEL_JTI_7f3a',
          kid: 'SENTINEL_KID_9c2e',
          assertionExpiresAtSeconds: tS + 60,
        })
      ).resolves.toEqual({ outcome: 'burned' })
      const logger = captureLogger()
      const runAt = (offsetS: number) =>
        createDelegationJtiPruner({ now: () => new Date((tS + offsetS) * 1000) }).prune(logger)

      await runAt(0)
      await runAt(89)
      await runAt(90)
      await runAt(389)
      await runAt(390)
      expect(await remainingJtis(orgAId)).toEqual(['SENTINEL_JTI_7f3a'])
      await runAt(391)
      expect(await remainingJtis(orgAId)).toEqual([])

      const counts = logger.info.mock.calls.map(([payload]) => payload.deletedCount)
      expect(counts).toEqual([0, 0, 0, 0, 0, 1])
      const logged = JSON.stringify(logger.info.mock.calls)
      expect(logged).not.toContain('SENTINEL_JTI_7f3a')
      expect(logged).not.toContain('SENTINEL_KID_9c2e')
      expect(logged).not.toContain(orgAId)
    })
  })

  it('bounded: batch 3 over 7 expired rows deletes 3, 3, 1, then 0, oldest first', async () => {
    await withTwoTestOrgs(async ({ orgAId }) => {
      const t = BASE_2001_MS + 2 * 86_400_000
      await seed(
        orgAId,
        Array.from({ length: 7 }, (_, i) => ({
          jti: `b-${i}`,
          expiresAtMs: t - 1_000_000 + i * 1000,
        }))
      )
      const logger = captureLogger()
      const pruner = createDelegationJtiPruner({ now: () => new Date(t), batchSize: 3 })

      await pruner.prune(logger)
      expect(await remainingJtis(orgAId)).toEqual(['b-3', 'b-4', 'b-5', 'b-6'])
      await pruner.prune(logger)
      expect(await remainingJtis(orgAId)).toEqual(['b-6'])
      await pruner.prune(logger)
      await pruner.prune(logger)
      expect(await remainingJtis(orgAId)).toEqual([])

      expect(logger.info.mock.calls).toEqual([
        [{ eventType: COMPLETED, jobName: JOB, deletedCount: 3 }],
        [{ eventType: 'job.backlog', jobName: JOB, batchSize: 3 }],
        [{ eventType: COMPLETED, jobName: JOB, deletedCount: 3 }],
        [{ eventType: 'job.backlog', jobName: JOB, batchSize: 3 }],
        [{ eventType: COMPLETED, jobName: JOB, deletedCount: 1 }],
        [{ eventType: COMPLETED, jobName: JOB, deletedCount: 0 }],
      ])
    })
  })
})
