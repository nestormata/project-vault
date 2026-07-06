import { gzipSync } from 'node:zlib'
import { and, asc, eq, gte, lte } from 'drizzle-orm'
import type { Tx } from '@project-vault/db'
import { auditExports, auditLogEntries } from '@project-vault/db/schema'
import { runOrgScopedJob } from '../../middleware/rls.js'
import { AUDIT_VERIFY_MAX_RANGE_DAYS, verifyAuditRange, type VerifyFailedEntry } from './verify.js'
import { toCsvRow, AUDIT_EXPORT_CSV_HEADER } from './csv.js'
import { actorDisplayNameFor, batchResolveActorDisplayNames } from './actor-display-name.js'

/** AC-10 — bounds total job runtime, distinct from the per-chunk verify cap. Enforced at the
 * POST route layer before any job is enqueued. */
export const AUDIT_EXPORT_MAX_RANGE_DAYS = 400

const MS_PER_DAY = 24 * 60 * 60 * 1000

export class ExportRangeTooLargeError extends Error {}

/** AC-10 — splits [from, to] into <= AUDIT_VERIFY_MAX_RANGE_DAYS sub-ranges so the export
 * worker can call verifyAuditRange() (Story 8.1) once per chunk without hitting its own
 * per-call range cap. Invisible to the HTTP caller — this is a background job. */
export function chunkExportRange(from: Date, to: Date, maxDaysPerChunk: number): [Date, Date][] {
  const chunks: [Date, Date][] = []
  const msPerChunk = maxDaysPerChunk * MS_PER_DAY
  let chunkStart = from.getTime()
  const end = to.getTime()
  if (chunkStart >= end) return [[from, to]]
  while (chunkStart < end) {
    const chunkEndMs = Math.min(chunkStart + msPerChunk, end)
    chunks.push([new Date(chunkStart), new Date(chunkEndMs)])
    chunkStart = chunkEndMs
  }
  return chunks
}

export type ExportIntegritySummary = {
  passed: number
  failedCount: number
  failed: VerifyFailedEntry[]
}

export type ExportCsvRow = {
  createdAt: Date
  actorTokenId: string | null
  actorType: string
  eventType: string
  resourceId: string | null
  resourceType: string | null
  orgId: string
  projectId: string | null
  ipAddress: string | null
}

/** AC-12 — pure CSV-building function, independently unit-testable from the DB/verify wiring. */
export function buildExportCsv(
  rows: {
    createdAt: string
    actorDisplayName: string
    eventType: string
    resourceId: string | null
    resourceType: string | null
    orgId: string
    projectId: string | null
    ipAddress: string | null
  }[],
  summary: { rowsChecked: number; passed: number; failedCount: number; verifiedAt: string } | null
): string {
  const lines = [AUDIT_EXPORT_CSV_HEADER]
  for (const row of rows) {
    lines.push(
      toCsvRow([
        row.createdAt,
        row.actorDisplayName,
        row.eventType,
        row.resourceId,
        row.resourceType,
        row.orgId,
        row.projectId,
        row.ipAddress,
      ])
    )
  }
  if (summary) {
    lines.push('--- Integrity Verification Summary ---')
    lines.push(
      `rows_checked,${summary.rowsChecked},passed,${summary.passed},failed,${summary.failedCount},verified_at,${summary.verifiedAt}`
    )
  }
  return lines.join('\n') + '\n'
}

async function fetchExportRows(
  tx: Tx,
  orgId: string,
  from: Date,
  to: Date
): Promise<ExportCsvRow[]> {
  const rows = await tx
    .select({
      createdAt: auditLogEntries.createdAt,
      actorTokenId: auditLogEntries.actorTokenId,
      actorType: auditLogEntries.actorType,
      eventType: auditLogEntries.eventType,
      resourceId: auditLogEntries.resourceId,
      resourceType: auditLogEntries.resourceType,
      orgId: auditLogEntries.orgId,
      projectId: auditLogEntries.projectId,
      ipAddress: auditLogEntries.ipAddress,
    })
    .from(auditLogEntries)
    .where(and(gte(auditLogEntries.createdAt, from), lte(auditLogEntries.createdAt, to)))
    .orderBy(asc(auditLogEntries.createdAt), asc(auditLogEntries.id))
  return rows
}

/**
 * AC-9/10/11 — the `audit:export` worker: mandatory integrity verification first (chunked
 * across <= AUDIT_VERIFY_MAX_RANGE_DAYS sub-ranges, Story 8.1's verifyAuditRange()), and only on
 * a fully-passing aggregate does it proceed to CSV generation. Never generates or stores a CSV
 * when verification fails — the single most important failure mode in this story (AC-11).
 */
export async function runAuditExport(input: { exportId: string; orgId: string }): Promise<void> {
  await runOrgScopedJob(input.orgId, 'audit/export', async ({ tx }) => {
    const [row] = await tx
      .select()
      .from(auditExports)
      .where(eq(auditExports.id, input.exportId))
      .limit(1)
    if (!row) {
      // The enqueuing HTTP transaction may not have committed yet by the time this job is
      // picked up (best-effort post-insert enqueue, matching this codebase's established
      // notification-dispatch pattern) — throwing lets pg-boss's retry policy (configured at
      // send-time) pick the row up a few seconds later instead of silently dropping the job.
      throw new Error(`audit export row not found yet: ${input.exportId}`)
    }
    if (row.status !== 'pending') return

    await tx
      .update(auditExports)
      .set({ status: 'processing' })
      .where(eq(auditExports.id, input.exportId))

    const chunks = chunkExportRange(row.fromDate, row.toDate, AUDIT_VERIFY_MAX_RANGE_DAYS)
    let rowsChecked = 0
    let passed = 0
    let failedCount = 0
    const failed: VerifyFailedEntry[] = []

    for (const [chunkFrom, chunkTo] of chunks) {
      const result = await verifyAuditRange(tx, {
        orgId: input.orgId,
        from: chunkFrom.toISOString(),
        to: chunkTo.toISOString(),
      })
      rowsChecked += result.rowsChecked
      passed += result.passed
      failedCount += result.failedCount
      failed.push(...result.failed)
    }

    if (failedCount > 0) {
      await tx
        .update(auditExports)
        .set({
          status: 'failed',
          errorReason: 'integrity_check_failed',
          rowsChecked,
          integritySummary: { passed, failedCount, failed: failed.slice(0, 500) },
          completedAt: new Date(),
        })
        .where(eq(auditExports.id, input.exportId))
      return
    }

    const dataRows = await fetchExportRows(tx, input.orgId, row.fromDate, row.toDate)
    const displayNameByTokenId = await batchResolveActorDisplayNames(
      tx,
      dataRows.map((r) => r.actorTokenId)
    )
    const verifiedAt = new Date().toISOString()
    const csv = buildExportCsv(
      dataRows.map((r) => ({
        createdAt: r.createdAt.toISOString(),
        actorDisplayName: actorDisplayNameFor(r.actorType, r.actorTokenId, displayNameByTokenId),
        eventType: r.eventType,
        resourceId: r.resourceId,
        resourceType: r.resourceType,
        orgId: r.orgId,
        projectId: r.projectId,
        ipAddress: r.ipAddress,
      })),
      row.includeIntegrityReport ? { rowsChecked, passed, failedCount, verifiedAt } : null
    )
    const gzipped = gzipSync(Buffer.from(csv, 'utf8'))

    await tx
      .update(auditExports)
      .set({
        status: 'completed',
        rowsChecked,
        integritySummary: { passed, failedCount, failed: failed.slice(0, 500) },
        fileContent: gzipped,
        completedAt: new Date(),
      })
      .where(eq(auditExports.id, input.exportId))
  })
}
