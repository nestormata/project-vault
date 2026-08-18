#!/usr/bin/env tsx
/**
 * Story 22.4 — Audit-Quota Latency Bench.
 *
 * Measures, on real hardware against a real Postgres, the added latency cost of
 * `assertOrgMayWriteAuditGates()` (Story 22.1/22.2's quota+rate gate) and any cross-tenant
 * latency coupling it introduces through the shared connection pool / shared usage row / shared
 * cluster. This is a MANUAL/OPERATIONAL bench, not a CI gate — it is never invoked by `make ci`
 * (see this story's frontmatter warning and Dev Notes "Testing Requirements Summary"). It
 * intentionally saturates a meaningful fraction of the shared connection pool for its
 * measurement window — run it only against a dedicated local or disposable Postgres instance,
 * NEVER against a shared dev/staging database or production.
 *
 * Usage:
 *   pnpm bench:audit-quota                 # orchestrator: runs both arms, prints combined report
 *   tsx scripts/audit-quota-isolation-bench.ts --arm=disabled   # single-arm child mode (internal)
 *   tsx scripts/audit-quota-isolation-bench.ts --arm=enabled    # single-arm child mode (internal)
 *
 * Design Decision D1 (see story Dev Notes): `apps/api/src/config/env.ts` exports `env` as a
 * module-level singleton parsed once from `process.env` at import time. Mutating
 * `process.env.AUDIT_ORG_QUOTA_ENFORCEMENT_ENABLED` after that module has been imported does NOT
 * change the already-parsed `env` object — there is no DI seam. The orchestrator therefore never
 * imports `quota-gate.ts` itself; it spawns two independent child OS processes (via
 * `node:child_process`), one per arm, each started with the correct env vars set BEFORE it
 * imports anything. `checkEnvSingletonFrozenAtImport()` below is a regression tripwire: if a
 * future refactor makes `env` mutable after import, this two-process architecture becomes
 * unnecessary complexity rather than a correctness requirement, and this check will start failing
 * loudly instead of the bench silently measuring two identical "arms".
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { sql } from 'drizzle-orm'
import { getDb, withOrg, type Tx } from '@project-vault/db'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SCRIPT_DIR, '..')
const THIS_FILE = fileURLToPath(import.meta.url)
const TSX_BIN = join(REPO_ROOT, 'node_modules', '.bin', 'tsx')

const BENCH_ORG_PREFIX = '__audit-quota-bench-'
const STALE_ORG_MAX_AGE_MS = 10 * 60 * 1000 // AC-8's stale-sweep threshold
const REGRESSION_THRESHOLD_PERCENT = 25
const WARMUP_FRACTION = 0.1
const REPETITIONS = 3
const ORG_A_WRITES_PER_REP = 1200
const ORG_A_CONCURRENCY = 6
const ORG_B_WRITES_TARGET_PER_REP = 80
const ORG_B_PACE_MS = 15
// Org B is a single sequential paced loop (see runArm's orgBPromise) — concurrency 1, not a
// second worker. Named here (rather than inlined at each call site) so the fingerprint block and
// the per-arm poolConcurrencyConfigured value can never drift apart again (a prior bug had the
// fingerprint hardcoded to 2 while the per-arm value correctly reported 1).
const ORG_B_CONCURRENCY = 1

// ---------------------------------------------------------------------------------------------
// Pure, unit-testable helpers (no DB/process side effects) — see
// scripts/audit-quota-isolation-bench.test.ts.
// ---------------------------------------------------------------------------------------------

export interface PercentileStats {
  p50: number
  p95: number
  p99: number
  count: number
}

/**
 * p50/p95/p99 from a latency array (milliseconds). Empty array and single-sample inputs are
 * explicit edge cases (AC's "Testing Requirements Summary"): an empty array returns all-zero
 * stats with count 0 rather than throwing or returning NaN; a single sample returns that sample
 * for every percentile. Nearest-rank method (ceil(p/100 * n) - 1), which ties percentile
 * boundaries to an existing rank rather than interpolating.
 */
export function computePercentiles(latenciesMs: readonly number[]): PercentileStats {
  if (latenciesMs.length === 0) {
    return { p50: 0, p95: 0, p99: 0, count: 0 }
  }
  const sorted = [...latenciesMs].sort((a, b) => a - b)
  const at = (p: number): number => {
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
    // eslint-disable-next-line security/detect-object-injection -- idx is a Math.min/max-clamped numeric index into a local array, never user input
    return sorted[idx] as number
  }
  return { p50: at(50), p95: at(95), p99: at(99), count: sorted.length }
}

/** Discards a leading warm-up fraction (AC-3) so JIT/connection-establishment effects at the
 * start of a run do not bias the percentile computation. */
export function discardWarmup<T>(items: readonly T[], warmupFraction = WARMUP_FRACTION): T[] {
  const warmupCount = Math.max(0, Math.floor(items.length * warmupFraction))
  return items.slice(warmupCount)
}

/**
 * Relative regression of `candidateMs` over `baselineMs`, as a percentage. `baselineMs <= 0` is
 * an edge case that should not occur in practice (a real p95 is always positive once any writes
 * completed) but is defined explicitly rather than dividing by zero: 0% if candidate is also
 * non-positive, otherwise +Infinity (an unambiguous, impossible-to-silently-average-away signal).
 */
export function computeRegressionPercent(baselineMs: number, candidateMs: number): number {
  if (baselineMs <= 0) return candidateMs > 0 ? Infinity : 0
  return ((candidateMs - baselineMs) / baselineMs) * 100
}

/**
 * AC-1's regression tripwire for Design Decision D1: asserts that mutating
 * `process.env.AUDIT_ORG_QUOTA_ENFORCEMENT_ENABLED` after `env` has already been imported does
 * NOT change the imported singleton's value. If this ever throws, the two-process architecture
 * this bench relies on may no longer be necessary (or, worse, `env` may have become partially
 * mutable in a way that makes the "one process per arm" isolation unreliable) — either way it is
 * a finding that must be investigated before trusting this bench's output.
 */
export function checkEnvSingletonFrozenAtImport(envSingleton: {
  readonly AUDIT_ORG_QUOTA_ENFORCEMENT_ENABLED: boolean
}): void {
  const before = envSingleton.AUDIT_ORG_QUOTA_ENFORCEMENT_ENABLED
  const originalRaw = process.env['AUDIT_ORG_QUOTA_ENFORCEMENT_ENABLED']
  try {
    process.env['AUDIT_ORG_QUOTA_ENFORCEMENT_ENABLED'] = String(!before)
    if (envSingleton.AUDIT_ORG_QUOTA_ENFORCEMENT_ENABLED !== before) {
      throw new Error(
        'REGRESSION (Story 22.4 Design Decision D1): mutating process.env post-import changed ' +
          "the imported env singleton's value. quota-gate.ts's env import is no longer a " +
          'load-once singleton — re-verify whether this bench still needs its two-process ' +
          'architecture, and whether any other code relying on env-as-frozen-at-import is affected.'
      )
    }
  } finally {
    if (originalRaw === undefined) delete process.env['AUDIT_ORG_QUOTA_ENFORCEMENT_ENABLED']
    else process.env['AUDIT_ORG_QUOTA_ENFORCEMENT_ENABLED'] = originalRaw
  }
}

export interface LockHoldStats {
  p50: number
  p95: number
  max: number
  /** true if the mean of the last third of the burst's lock-hold samples exceeds the mean of the
   * first third by >50% — a rough "is later-in-burst contention growing" signal (AC-5). */
  growing: boolean
}

export function computeLockHoldStats(samplesMs: readonly number[]): LockHoldStats {
  if (samplesMs.length === 0) return { p50: 0, p95: 0, max: 0, growing: false }
  const { p50, p95 } = computePercentiles(samplesMs)
  const max = Math.max(...samplesMs)
  const third = Math.max(1, Math.floor(samplesMs.length / 3))
  const mean = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length
  const firstThird = mean(samplesMs.slice(0, third))
  const lastThird = mean(samplesMs.slice(-third))
  const growing = firstThird > 0 && lastThird > firstThird * 1.5
  return { p50, p95, max, growing }
}

export interface PgStatSnapshot {
  nDeadTup: number
  nTupUpd: number
  nTupHotUpd: number
  lastAutovacuum: string | null
}

export interface PgStatDelta {
  before: PgStatSnapshot
  after: PgStatSnapshot
  deltaDeadTup: number
  deltaTupUpd: number
  deltaTupHotUpd: number
  hotUpdateRatio: number
}

/** `n_tup_hot_upd / n_tup_upd` over the delta window — a proxy for how effectively
 * `fillfactor = 70` is favouring HOT updates under real write pressure (AC-6). */
export function computePgStatDelta(before: PgStatSnapshot, after: PgStatSnapshot): PgStatDelta {
  const deltaDeadTup = after.nDeadTup - before.nDeadTup
  const deltaTupUpd = after.nTupUpd - before.nTupUpd
  const deltaTupHotUpd = after.nTupHotUpd - before.nTupHotUpd
  const hotUpdateRatio = deltaTupUpd > 0 ? deltaTupHotUpd / deltaTupUpd : 0
  return { before, after, deltaDeadTup, deltaTupUpd, deltaTupHotUpd, hotUpdateRatio }
}

export interface IsolationCheck {
  orgAExpected: number
  orgAActual: number
  orgBExpected: number
  orgBActual: number
  ok: boolean
  anomalies: string[]
}

/** AC-7's self-checking correctness assertion: each org's final usage-row entry_count must match
 * what that org actually attempted (never the other org's traffic bleeding across). */
export function checkTenantIsolation(input: {
  orgAAttempted: number
  orgAUsageEntryCount: number
  orgBAttempted: number
  orgBUsageEntryCount: number
}): IsolationCheck {
  const anomalies: string[] = []
  if (input.orgAUsageEntryCount > input.orgAAttempted) {
    anomalies.push(
      `org A usage entry_count (${input.orgAUsageEntryCount}) exceeds its own attempted writes ` +
        `(${input.orgAAttempted}) — possible cross-tenant contamination`
    )
  }
  if (input.orgBUsageEntryCount > input.orgBAttempted) {
    anomalies.push(
      `org B usage entry_count (${input.orgBUsageEntryCount}) exceeds its own attempted writes ` +
        `(${input.orgBAttempted}) — possible cross-tenant contamination`
    )
  }
  return {
    orgAExpected: input.orgAAttempted,
    orgAActual: input.orgAUsageEntryCount,
    orgBExpected: input.orgBAttempted,
    orgBActual: input.orgBUsageEntryCount,
    ok: anomalies.length === 0,
    anomalies,
  }
}

export interface ArmResult {
  arm: 'enabled' | 'disabled'
  orgB: {
    repetitions: PercentileStats[]
    aggregate: PercentileStats
    attempted: number
    completed: number
  }
  orgA: {
    attempted: number
    completed: number
  }
  poolPeakConnections: number
  poolConcurrencyConfigured: { orgA: number; orgB: number }
  lockHoldProxyMs: LockHoldStats
  pgStat: PgStatDelta
  isolation: IsolationCheck
}

export interface CombinedReport {
  fingerprint: {
    commitHash: string
    timestamp: string
    concurrency: { orgA: number; orgB: number }
    repetitions: number
  }
  disabled: ArmResult
  enabled: ArmResult
  regressionPercentByRepetition: number[]
  regressionPercentAggregate: number
  thresholdPercent: number
  pass: boolean
}

/** Combines the two arms' already-computed results into the final report, including the
 * relative-only regression comparison (AC-3) — pure function, no I/O, fully unit-testable. */
export function buildCombinedReport(input: {
  disabled: ArmResult
  enabled: ArmResult
  commitHash: string
  timestamp: string
}): CombinedReport {
  const { disabled, enabled } = input
  const repCount = Math.min(disabled.orgB.repetitions.length, enabled.orgB.repetitions.length)
  const regressionPercentByRepetition: number[] = []
  for (let i = 0; i < repCount; i++) {
    const base = disabled.orgB.repetitions[i]
    const cand = enabled.orgB.repetitions[i]
    if (base && cand) {
      regressionPercentByRepetition.push(computeRegressionPercent(base.p95, cand.p95))
    }
  }
  const regressionPercentAggregate = computeRegressionPercent(
    disabled.orgB.aggregate.p95,
    enabled.orgB.aggregate.p95
  )
  return {
    fingerprint: {
      commitHash: input.commitHash,
      timestamp: input.timestamp,
      concurrency: { orgA: ORG_A_CONCURRENCY, orgB: ORG_B_CONCURRENCY },
      repetitions: REPETITIONS,
    },
    disabled,
    enabled,
    regressionPercentByRepetition,
    regressionPercentAggregate,
    thresholdPercent: REGRESSION_THRESHOLD_PERCENT,
    pass: regressionPercentAggregate <= REGRESSION_THRESHOLD_PERCENT,
  }
}

// ---------------------------------------------------------------------------------------------
// Console report rendering (pure, testable on a CombinedReport fixture).
// ---------------------------------------------------------------------------------------------

export function renderConsoleSummary(report: CombinedReport): string {
  const lines: string[] = []
  lines.push('')
  lines.push('=== Story 22.4 — Audit-Quota Isolation Bench ===')
  lines.push(
    `commit=${report.fingerprint.commitHash} timestamp=${report.fingerprint.timestamp} ` +
      `orgA_concurrency=${report.fingerprint.concurrency.orgA} orgB_concurrency=${report.fingerprint.concurrency.orgB} ` +
      `repetitions=${report.fingerprint.repetitions}`
  )
  for (const arm of [report.disabled, report.enabled]) {
    lines.push('')
    lines.push(`--- arm: ${arm.arm} ---`)
    lines.push(
      `org B p50/p95/p99 (aggregate, warm-up discarded): ${arm.orgB.aggregate.p50.toFixed(2)}ms / ` +
        `${arm.orgB.aggregate.p95.toFixed(2)}ms / ${arm.orgB.aggregate.p99.toFixed(2)}ms ` +
        `(n=${arm.orgB.aggregate.count}, completed ${arm.orgB.completed}/${arm.orgB.attempted})`
    )
    arm.orgB.repetitions.forEach((rep, i) => {
      lines.push(
        `  rep ${i + 1}: p50=${rep.p50.toFixed(2)}ms p95=${rep.p95.toFixed(2)}ms p99=${rep.p99.toFixed(2)}ms n=${rep.count}`
      )
    })
    lines.push(
      `org A: ${arm.orgA.completed}/${arm.orgA.attempted} writes completed across ${report.fingerprint.repetitions} reps`
    )
    lines.push(
      `peak pool utilization: ${arm.poolPeakConnections} simultaneous in-flight transactions ` +
        `(harness-side counter proxy, concurrency configured: orgA=${arm.poolConcurrencyConfigured.orgA} orgB=${arm.poolConcurrencyConfigured.orgB})`
    )
    lines.push(
      `lock-hold proxy (gate-completes -> COMMIT-completes): p50=${arm.lockHoldProxyMs.p50.toFixed(3)}ms ` +
        `p95=${arm.lockHoldProxyMs.p95.toFixed(3)}ms max=${arm.lockHoldProxyMs.max.toFixed(3)}ms ` +
        `growing=${arm.lockHoldProxyMs.growing}`
    )
    lines.push(
      `pg_stat_user_tables delta: +${arm.pgStat.deltaDeadTup} dead tuples, ` +
        `+${arm.pgStat.deltaTupUpd} updates (${arm.pgStat.deltaTupHotUpd} HOT, ratio=${(arm.pgStat.hotUpdateRatio * 100).toFixed(1)}%), ` +
        `last_autovacuum=${arm.pgStat.after.lastAutovacuum ?? 'null (none observed in window)'}`
    )
    lines.push(
      `tenant isolation self-check: ${arm.isolation.ok ? 'OK' : 'ANOMALY'} ` +
        `(orgA ${arm.isolation.orgAActual}/${arm.isolation.orgAExpected}, orgB ${arm.isolation.orgBActual}/${arm.isolation.orgBExpected})`
    )
    if (!arm.isolation.ok) {
      for (const anomaly of arm.isolation.anomalies) lines.push(`  ANOMALY: ${anomaly}`)
    }
  }
  lines.push('')
  lines.push(
    `regression (org B p95, enabled vs disabled, aggregate): ${report.regressionPercentAggregate.toFixed(1)}% ` +
      `(threshold ${report.thresholdPercent}%) -> ${report.pass ? 'PASS' : 'FAIL'}`
  )
  lines.push(
    `regression by repetition: ${report.regressionPercentByRepetition.map((r) => `${r.toFixed(1)}%`).join(', ')}`
  )
  lines.push('')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------------------------
// Child-process arm runner. Everything below imports quota-gate.ts / env.ts — this module-level
// import graph is why the orchestrator NEVER imports this file's DB-touching functions directly;
// it only spawns a child process per Design Decision D1.
// ---------------------------------------------------------------------------------------------

interface RepresentativePayload {
  eventType: string
  payload: Record<string, unknown>
  resourceId?: string
  resourceType?: string
}

function representativePayloads(): RepresentativePayload[] {
  return [
    {
      eventType: 'credential.value_revealed',
      payload: {
        credentialId: crypto.randomUUID(),
        projectId: crypto.randomUUID(),
        revealedBy: crypto.randomUUID(),
        reason: 'audit-quota-bench-synthetic-write',
        ipAddress: '203.0.113.7',
      },
      resourceId: crypto.randomUUID(),
      resourceType: 'credential',
    },
    {
      eventType: 'human.login_succeeded',
      payload: {
        userId: crypto.randomUUID(),
        method: 'password',
        ipAddress: '198.51.100.23',
        userAgent: 'audit-quota-bench/1.0',
      },
    },
  ]
}

async function createBenchOrg(
  db: ReturnType<typeof getDb>,
  arm: string,
  role: 'org-a' | 'org-b'
): Promise<string> {
  const orgId = crypto.randomUUID()
  const slugSuffix = orgId.slice(0, 8)
  const name = `${BENCH_ORG_PREFIX}${arm}-${role}-${slugSuffix}`
  await db.execute(
    sql`INSERT INTO organizations (id, name, slug) VALUES (${orgId}, ${name}, ${name})`
  )
  return orgId
}

async function configureBenchOrgQuota(
  db: ReturnType<typeof getDb>,
  orgId: string,
  operatorId: string
): Promise<void> {
  const { setOrgAuditQuota } = await import('../apps/api/src/modules/audit/quota-config.js')
  // Story 22.4 AC-8: generous, explicit, per-org config — never the instance-wide env default.
  // Quota comfortably above what ORG_A_WRITES_PER_REP * REPETITIONS synthetic writes at this
  // payload size will consume; rate comfortably above the burst's per-minute rate, so the burst
  // exercises the gate's ADMITTED path (what this story measures), not the refusal path.
  await db.transaction((tx) =>
    setOrgAuditQuota(tx as never, {
      orgId,
      quotaBytes: 1024 * 1024 * 1024, // 1 GiB
      writeRatePerMinute: 1_000_000,
      operatorId,
    })
  )
}

async function createBenchUser(db: ReturnType<typeof getDb>, label: string): Promise<string> {
  const email = `${label}-${crypto.randomUUID()}@example.com`
  const rows = await db.execute<{ id: string }>(
    sql`INSERT INTO users (email, password_hash) VALUES (${email}, 'x') RETURNING id`
  )
  const userId = (rows[0] as { id: string }).id
  await db.execute(
    sql`INSERT INTO user_identity_tokens (user_id, display_name) VALUES (${userId}, ${email})`
  )
  return userId
}

/** AC-8's stale-org sweep: bench orgs are named `__audit-quota-bench-*`; a crashed prior run
 * leaks its synthetic orgs, so a fresh run first deletes any bench org older than
 * STALE_ORG_MAX_AGE_MS. Cascade-deletes `audit_storage_quota_config`/`audit_org_storage_usage`
 * (FK `ON DELETE CASCADE`); if the org wrote committed `audit_log_entries` rows (it did, per
 * AC-2's discipline), the `organizations` delete itself will hit a foreign_key_violation — this
 * mirrors `@project-vault/db/test-helpers`'s own `cleanupTestOrg()` precedent exactly (append-only
 * audit rows make full org deletion impossible by design, matching production). That residual
 * `organizations` row (with its cascade-target config/usage rows also therefore not deleted) is a
 * known, accepted limitation — see the story's Dev Agent Record — not a bug in this sweep.
 */
async function sweepStaleBenchOrgs(db: ReturnType<typeof getDb>): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_ORG_MAX_AGE_MS).toISOString()
  const staleRows = await db.execute<{ id: string }>(
    sql`SELECT id FROM organizations WHERE name LIKE ${BENCH_ORG_PREFIX + '%'} AND created_at < ${cutoff}`
  )
  let swept = 0
  for (const row of staleRows) {
    const orgId = (row as { id: string }).id
    try {
      await db.execute(sql`DELETE FROM organizations WHERE id = ${orgId}`)
      swept++
    } catch {
      // Expected for orgs that wrote committed audit_log_entries rows — tolerate and move on,
      // matching @project-vault/db/test-helpers' cleanupTestOrg() precedent.
    }
  }
  return swept
}

async function cleanupBenchOrg(db: ReturnType<typeof getDb>, orgId: string): Promise<void> {
  try {
    await db.execute(sql`DELETE FROM organizations WHERE id = ${orgId}`)
  } catch {
    // Tolerated: audit_log_entries FK-blocks the delete once the org has written committed rows
    // (append-only by design — see sweepStaleBenchOrgs's comment above).
  }
}

interface WriteOutcome {
  totalMs: number
  lockHoldProxyMs: number
}

async function timedAuditedWrite(
  orgId: string,
  spec: RepresentativePayload
): Promise<WriteOutcome> {
  const { assertOrgMayWriteAuditGates, estimateAuditEntrySizeBytes } =
    await import('../apps/api/src/modules/audit/quota-gate.js')
  const sizeBytes = estimateAuditEntrySizeBytes({
    payload: spec.payload,
    resourceId: spec.resourceId,
    resourceType: spec.resourceType,
  })
  let gateDoneAt = 0n
  const start = process.hrtime.bigint()
  await withOrg(orgId, async (tx) => {
    await assertOrgMayWriteAuditGates(tx as Tx, {
      orgId,
      eventType: spec.eventType,
      sizeBytes,
    })
    gateDoneAt = process.hrtime.bigint()
    await tx.execute(sql`
      INSERT INTO audit_log_entries
        (org_id, actor_type, event_type, resource_id, resource_type, payload, key_version, hmac)
      VALUES
        (${orgId}, 'system', ${spec.eventType}, ${spec.resourceId ?? null}, ${spec.resourceType ?? null},
         ${JSON.stringify(spec.payload)}::jsonb, 1, 'audit-quota-bench-placeholder-hmac')
    `)
  })
  const end = process.hrtime.bigint()
  return {
    totalMs: Number(end - start) / 1e6,
    lockHoldProxyMs: Number(end - gateDoneAt) / 1e6,
  }
}

/** Simple bounded-concurrency worker pool, no external deps. */
async function runConcurrent<T>(
  count: number,
  concurrency: number,
  worker: (i: number) => Promise<T>,
  onEach?: (result: T) => void
): Promise<T[]> {
  const results: T[] = []
  let next = 0
  async function runner(): Promise<void> {
    for (;;) {
      const i = next++
      if (i >= count) return
      const result = await worker(i)
      results.push(result)
      onEach?.(result)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, count) }, () => runner()))
  return results
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function readPgStatSnapshot(db: ReturnType<typeof getDb>): Promise<PgStatSnapshot> {
  const rows = await db.execute<{
    n_dead_tup: number
    n_tup_upd: number
    n_tup_hot_upd: number
    last_autovacuum: string | null
  }>(sql`
    SELECT n_dead_tup, n_tup_upd, n_tup_hot_upd, last_autovacuum
      FROM pg_stat_user_tables
     WHERE relname = 'audit_org_storage_usage'
  `)
  const row = rows[0]
  return {
    nDeadTup: Number(row?.n_dead_tup ?? 0),
    nTupUpd: Number(row?.n_tup_upd ?? 0),
    nTupHotUpd: Number(row?.n_tup_hot_upd ?? 0),
    lastAutovacuum: row?.last_autovacuum ?? null,
  }
}

async function readUsageEntryCount(db: ReturnType<typeof getDb>, orgId: string): Promise<number> {
  const rows = await withOrg(orgId, (tx) =>
    tx.execute<{ entry_count: string }>(
      sql`SELECT entry_count FROM audit_org_storage_usage WHERE org_id = ${orgId}`
    )
  )
  return Number(rows[0]?.entry_count ?? 0)
}

/**
 * `setOrgAuditQuota()` (used to configure the two synthetic orgs' generous quota/rate) writes a
 * platform audit entry, which requires the vault to be unsealed in THIS process (vault "unsealed"
 * status is process-local memory, not just a DB row) — mirroring
 * apps/api/src/modules/audit/quota-config.test.ts's own setup exactly. A disposable local bench
 * DB is reset+reinitialized on every arm run; this is setup-only, never part of the timed region.
 */
async function ensureVaultUnsealed(): Promise<void> {
  const { resetVaultForTest } =
    await import('../apps/api/src/__tests__/helpers/vault-test-cleanup.js')
  const { initVault } = await import('../apps/api/src/modules/vault/key-service.js')
  await resetVaultForTest()
  try {
    await initVault({ kmsType: 'passphrase', passphrase: 'audit-quota-bench-passphrase' }, {})
  } catch (error) {
    if ((error as { code?: string }).code !== 'ALREADY_INITIALIZED') throw error
  }
}

async function runArm(arm: 'enabled' | 'disabled'): Promise<ArmResult> {
  const db = getDb()
  const payloads = representativePayloads()

  process.stderr.write(`[bench:${arm}] initializing vault (setup only, not timed)...\n`)
  await ensureVaultUnsealed()

  process.stderr.write(`[bench:${arm}] sweeping stale bench orgs...\n`)
  const swept = await sweepStaleBenchOrgs(db)
  process.stderr.write(`[bench:${arm}] swept ${swept} stale bench org(s)\n`)

  const operatorId = await createBenchUser(db, `audit-quota-bench-operator-${arm}`)
  const orgAId = await createBenchOrg(db, arm, 'org-a')
  const orgBId = await createBenchOrg(db, arm, 'org-b')
  await configureBenchOrgQuota(db, orgAId, operatorId)
  await configureBenchOrgQuota(db, orgBId, operatorId)

  let poolActive = 0
  let poolPeak = 0
  const trackPool = async <T>(fn: () => Promise<T>): Promise<T> => {
    poolActive++
    poolPeak = Math.max(poolPeak, poolActive)
    try {
      return await fn()
    } finally {
      poolActive--
    }
  }

  // Seed org A's usage row (AC-3's edge case: the entire measured burst must exercise the
  // ON CONFLICT ... DO UPDATE branch against an already-existing row, not the one-time INSERT
  // branch) — one untimed write before any repetition starts.
  await trackPool(() => timedAuditedWrite(orgAId, payloads[0] as RepresentativePayload))

  // AC-7's isolation self-check must compare the MEASURED WINDOW's delta, not an absolute count:
  // both the seed write above and configureBenchOrgQuota()'s own audit.quota_configured entry
  // (an EXEMPT write that still increments entry_count) touch the usage row as legitimate setup
  // before the timed burst starts. Snapshot the baseline here so the isolation check below only
  // asserts about writes actually attempted during the measured repetitions.
  const orgAEntryCountBaseline = await readUsageEntryCount(db, orgAId)
  const orgBEntryCountBaseline = await readUsageEntryCount(db, orgBId)

  const orgBRepetitions: PercentileStats[] = []
  const allOrgBLatencies: number[] = []
  const lockHoldSamples: number[] = []
  let orgAAttempted = 0
  let orgACompleted = 0
  let orgBAttempted = 0
  let orgBCompleted = 0

  const before = await readPgStatSnapshot(db)

  for (let rep = 0; rep < REPETITIONS; rep++) {
    process.stderr.write(`[bench:${arm}] repetition ${rep + 1}/${REPETITIONS}...\n`)
    let active = true
    const orgBLatenciesThisRep: number[] = []

    const orgAPromise = runConcurrent(ORG_A_WRITES_PER_REP, ORG_A_CONCURRENCY, async (i) => {
      orgAAttempted++
      const spec = payloads[i % payloads.length] as RepresentativePayload
      const outcome = await trackPool(() => timedAuditedWrite(orgAId, spec))
      orgACompleted++
      lockHoldSamples.push(outcome.lockHoldProxyMs)
      return outcome
    }).then(() => {
      active = false
    })

    const orgBPromise = (async () => {
      let i = 0
      while (active && i < ORG_B_WRITES_TARGET_PER_REP) {
        orgBAttempted++
        const spec = payloads[i % payloads.length] as RepresentativePayload
        const outcome = await trackPool(() => timedAuditedWrite(orgBId, spec))
        orgBCompleted++
        orgBLatenciesThisRep.push(outcome.totalMs)
        allOrgBLatencies.push(outcome.totalMs)
        i++
        await sleep(ORG_B_PACE_MS)
      }
    })()

    await Promise.all([orgAPromise, orgBPromise])

    const repStats = computePercentiles(discardWarmup(orgBLatenciesThisRep))
    orgBRepetitions.push(repStats)
  }

  const after = await readPgStatSnapshot(db)
  const pgStat = computePgStatDelta(before, after)

  const orgAUsageEntryCount = (await readUsageEntryCount(db, orgAId)) - orgAEntryCountBaseline
  const orgBUsageEntryCount = (await readUsageEntryCount(db, orgBId)) - orgBEntryCountBaseline
  const isolation = checkTenantIsolation({
    orgAAttempted,
    orgAUsageEntryCount,
    orgBAttempted,
    orgBUsageEntryCount,
  })

  await cleanupBenchOrg(db, orgAId)
  await cleanupBenchOrg(db, orgBId)

  const aggregate = computePercentiles(discardWarmup(allOrgBLatencies))

  return {
    arm,
    orgB: {
      repetitions: orgBRepetitions,
      aggregate,
      attempted: orgBAttempted,
      completed: orgBCompleted,
    },
    orgA: { attempted: orgAAttempted, completed: orgACompleted },
    poolPeakConnections: poolPeak,
    poolConcurrencyConfigured: { orgA: ORG_A_CONCURRENCY, orgB: ORG_B_CONCURRENCY },
    lockHoldProxyMs: computeLockHoldStats(lockHoldSamples),
    pgStat,
    isolation,
  }
}

async function childMain(arm: 'enabled' | 'disabled'): Promise<void> {
  const { env } = await import('../apps/api/src/config/env.js')
  checkEnvSingletonFrozenAtImport(env)
  if (
    (arm === 'enabled') !==
    (env.AUDIT_ORG_QUOTA_ENFORCEMENT_ENABLED && env.AUDIT_ORG_WRITE_RATE_ENFORCEMENT_ENABLED)
  ) {
    throw new Error(
      `[bench:${arm}] FATAL: env's enforcement flags do not match the requested arm — ` +
        `AUDIT_ORG_QUOTA_ENFORCEMENT_ENABLED=${env.AUDIT_ORG_QUOTA_ENFORCEMENT_ENABLED} ` +
        `AUDIT_ORG_WRITE_RATE_ENFORCEMENT_ENABLED=${env.AUDIT_ORG_WRITE_RATE_ENFORCEMENT_ENABLED}. ` +
        'The child process was not launched with the correct env vars set before import.'
    )
  }
  const result = await runArm(arm)
  // Single, final stdout write — the orchestrator parses only the LAST line of this child's
  // stdout as JSON. All progress output above goes to stderr.
  process.stdout.write(`${JSON.stringify(result)}\n`)
  // The postgres.js pool keeps live sockets open (idle_timeout is not configured), which would
  // otherwise keep this short-lived child process alive indefinitely. Exit explicitly once the
  // result has been flushed to stdout.
  process.exit(0)
}

// ---------------------------------------------------------------------------------------------
// Orchestrator (parent process) — never imports quota-gate.ts/env.ts.
// ---------------------------------------------------------------------------------------------

function getGitCommitHash(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  } catch {
    return 'unknown'
  }
}

function spawnArm(arm: 'enabled' | 'disabled', databaseUrl: string, adminUrl: string): ArmResult {
  const enabled = arm === 'enabled'
  process.stderr.write(`\n=== spawning child process for arm=${arm} ===\n`)
  const stdout = execFileSync(TSX_BIN, [THIS_FILE, `--arm=${arm}`], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 64,
    stdio: ['ignore', 'pipe', 'inherit'],
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      ADMIN_DATABASE_URL: adminUrl,
      VAULT_ALLOW_REMOTE_INIT: 'true',
      AUDIT_ORG_QUOTA_ENFORCEMENT_ENABLED: String(enabled),
      AUDIT_ORG_WRITE_RATE_ENFORCEMENT_ENABLED: String(enabled),
    },
  })
  const lines = stdout.trim().split('\n')
  const lastLine = lines[lines.length - 1]
  if (!lastLine) throw new Error(`[bench] arm=${arm} produced no stdout`)
  return JSON.parse(lastLine) as ArmResult
}

async function orchestratorMain(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL']
  const adminUrl = process.env['ADMIN_DATABASE_URL']
  if (!databaseUrl) {
    process.stderr.write(
      'FATAL: DATABASE_URL is required (point at a dedicated local/disposable Postgres — never production).\n'
    )
    process.exit(1)
  }
  if (!adminUrl) {
    process.stderr.write(
      'FATAL: ADMIN_DATABASE_URL is required (env.ts requires it unconditionally).\n'
    )
    process.exit(1)
  }

  const disabled = spawnArm('disabled', databaseUrl, adminUrl)
  const enabled = spawnArm('enabled', databaseUrl, adminUrl)

  const report = buildCombinedReport({
    disabled,
    enabled,
    commitHash: getGitCommitHash(),
    timestamp: new Date().toISOString(),
  })

  process.stdout.write(renderConsoleSummary(report))

  const outputDir = join(REPO_ROOT, 'scripts', '.bench-output')
  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true })
  const artifactPath = join(
    outputDir,
    `audit-quota-bench-${report.fingerprint.timestamp.replace(/[:.]/g, '-')}.json`
  )
  writeFileSync(artifactPath, JSON.stringify(report, null, 2))
  process.stdout.write(`JSON artifact written to ${artifactPath}\n`)

  if (!report.pass) {
    process.stdout.write(
      `\nFINDING: AC-3's regression threshold (${report.thresholdPercent}%) was exceeded ` +
        `(${report.regressionPercentAggregate.toFixed(1)}%). This is a finding to record in ` +
        'docs/operations/audit-quota-degradation-strategy.md, never a threshold to quietly loosen.\n'
    )
  }
  if (!disabled.isolation.ok || !enabled.isolation.ok) {
    process.stdout.write(
      '\nBLOCKING ANOMALY: tenant isolation self-check failed in at least one arm — see above. ' +
        "Discard this run's latency numbers; the measurement methodology itself is broken.\n"
    )
    process.exitCode = 1
  }
  process.exit(process.exitCode ?? 0)
}

// ---------------------------------------------------------------------------------------------
// Entrypoint guard — only runs when this file is executed directly (never on import, e.g. from
// scripts/audit-quota-isolation-bench.test.ts).
// ---------------------------------------------------------------------------------------------

const isDirectRun = (() => {
  const invoked = process.argv[1]
  if (!invoked) return false
  try {
    return resolve(invoked) === THIS_FILE
  } catch {
    return false
  }
})()

if (isDirectRun) {
  const armArg = process.argv.find((a) => a.startsWith('--arm='))
  if (armArg) {
    const arm = armArg.split('=')[1]
    if (arm !== 'enabled' && arm !== 'disabled') {
      process.stderr.write(`FATAL: --arm must be "enabled" or "disabled", got "${arm}"\n`)
      process.exit(1)
    }
    childMain(arm).catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
      process.exit(1)
    })
  } else {
    orchestratorMain().catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`)
      process.exit(1)
    })
  }
}
