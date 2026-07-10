import { gzipSync } from 'node:zlib'
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { and, eq, gte, lt } from 'drizzle-orm'
import type { EncryptedValue } from '@project-vault/crypto'
import { withSecret } from '@project-vault/crypto'
import type { Tx } from '@project-vault/db'
import { auditForwardingConfig, auditLogEntries } from '@project-vault/db/schema'
import { OperationalEvent } from '@project-vault/shared'
import type { FastifyBaseLogger } from 'fastify'
import { operationalLog } from '../../lib/logger.js'
import { fetchAllOrgIds, runOrgScopedJob } from '../../middleware/rls.js'
import { applyForwardingConfigUpdate } from './forwarding-config-update.js'

/** D3 — five consecutive failed daily attempts (a longer failure window than the webhook's
 * once-a-minute AUDIT_WEBHOOK_MAX_CONSECUTIVE_FAILURES=10, matched to a once-a-day cadence). */
export const AUDIT_S3_MAX_CONSECUTIVE_FAILURES = 5

type WorkerLogger = Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>

/** Injectable so tests never construct a real S3Client / make a real network call. Defaults to
 * a real @aws-sdk/client-s3 PutObjectCommand call in production. */
export type S3PutObjectFn = (input: {
  bucket: string
  key: string
  body: Buffer
  region: string
  accessKeyId: string
  secretAccessKey: string
  endpoint?: string
}) => Promise<void>

export const defaultS3PutObject: S3PutObjectFn = async (input) => {
  const client = new S3Client({
    region: input.region,
    credentials: { accessKeyId: input.accessKeyId, secretAccessKey: input.secretAccessKey },
    ...(input.endpoint ? { endpoint: input.endpoint, forcePathStyle: true } : {}),
  })
  try {
    await client.send(
      new PutObjectCommand({ Bucket: input.bucket, Key: input.key, Body: input.body })
    )
  } finally {
    client.destroy()
  }
}

function toUtcDateString(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function addUtcDays(dateString: string, days: number): string {
  const date = new Date(`${dateString}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return toUtcDateString(date)
}

function yesterdayUtc(): string {
  return addUtcDays(toUtcDateString(new Date()), -1)
}

/** AC-19 — the oldest not-yet-forwarded UTC day: `s3LastForwardedDate + 1 day`, or yesterday if
 * never forwarded before. Never skips ahead while an earlier day remains unforwarded. */
export function nextDayToForward(s3LastForwardedDate: string | null): string {
  if (s3LastForwardedDate === null) return yesterdayUtc()
  return addUtcDays(s3LastForwardedDate, 1)
}

type S3ConfigRow = typeof auditForwardingConfig.$inferSelect

async function fetchDayRows(tx: Tx, orgId: string, day: string) {
  const dayStart = new Date(`${day}T00:00:00.000Z`)
  const dayEnd = new Date(`${addUtcDays(day, 1)}T00:00:00.000Z`)
  return tx
    .select()
    .from(auditLogEntries)
    .where(
      and(
        eq(auditLogEntries.orgId, orgId),
        gte(auditLogEntries.createdAt, dayStart),
        lt(auditLogEntries.createdAt, dayEnd)
      )
    )
}

/** AC-19 — processes exactly one org's daily S3 batch: computes the oldest not-yet-forwarded
 * UTC day, uploads it as gzipped JSONL (or advances with no upload if the day has zero rows),
 * and only ever attempts ONE day per tick — the same day is retried on the next run if it
 * fails, never skipped. */
function hasS3Credentials(config: S3ConfigRow): boolean {
  return Boolean(
    config.s3Bucket && config.s3Region && config.s3AccessKeyId && config.s3SecretAccessKeyEncrypted
  )
}

/** AC-19 zero-rows edge case: no object uploaded, but the watermark still advances (an empty
 * gzip file would be misleading — "we checked, nothing happened" != "we forgot"). */
async function advanceEmptyDay(
  tx: Tx,
  config: S3ConfigRow,
  day: string,
  logger: WorkerLogger | undefined
): Promise<void> {
  await tx
    .update(auditForwardingConfig)
    .set({ s3LastForwardedDate: day, s3ConsecutiveFailureCount: 0, updatedAt: new Date() })
    .where(eq(auditForwardingConfig.orgId, config.orgId))
  if (!logger) return
  // "No rows for the day" is a normal, frequent, non-error condition; logged at info level
  // (this logger interface has no distinct debug level), never treated as a failure.
  operationalLog(
    logger,
    'info',
    OperationalEvent.AUDIT_S3_FORWARD_DAY_SKIPPED_EMPTY,
    'S3 forwarding: no rows for day, watermark advanced without an upload',
    { orgId: config.orgId, day }
  )
}

async function uploadDayBatch(
  config: S3ConfigRow & { s3Bucket: string; s3Region: string; s3AccessKeyId: string },
  day: string,
  rows: unknown[],
  putObject: S3PutObjectFn
): Promise<boolean> {
  const jsonl = rows.map((row) => JSON.stringify(row)).join('\n')
  const gzipped = gzipSync(Buffer.from(jsonl, 'utf8'))
  const key = `${config.s3Prefix ?? ''}${day}.jsonl.gz`
  try {
    const secretAccessKey = await withSecret(
      config.s3SecretAccessKeyEncrypted as unknown as EncryptedValue,
      (plaintext) => Promise.resolve(plaintext.toString('utf8'))
    )
    await putObject({
      bucket: config.s3Bucket,
      key,
      body: gzipped,
      region: config.s3Region,
      accessKeyId: config.s3AccessKeyId,
      secretAccessKey,
      ...(config.s3Endpoint ? { endpoint: config.s3Endpoint } : {}),
    })
    return true
  } catch {
    return false
  }
}

async function recordS3DaySuccess(tx: Tx, config: S3ConfigRow, day: string): Promise<void> {
  await tx
    .update(auditForwardingConfig)
    .set({ s3LastForwardedDate: day, s3ConsecutiveFailureCount: 0, updatedAt: new Date() })
    .where(eq(auditForwardingConfig.orgId, config.orgId))
}

async function recordS3DayFailure(
  tx: Tx,
  config: S3ConfigRow,
  day: string,
  logger: WorkerLogger | undefined
): Promise<void> {
  const s3ConsecutiveFailureCount = config.s3ConsecutiveFailureCount + 1
  const disable = s3ConsecutiveFailureCount >= AUDIT_S3_MAX_CONSECUTIVE_FAILURES
  await applyForwardingConfigUpdate(tx, config.orgId, {
    s3ConsecutiveFailureCount,
    enabled: disable ? false : config.enabled,
  })
  if (!logger) return
  operationalLog(
    logger,
    disable ? 'error' : 'warn',
    disable
      ? OperationalEvent.AUDIT_S3_FORWARD_DISABLED
      : OperationalEvent.AUDIT_S3_FORWARD_UPLOAD_FAILED,
    disable
      ? 'S3 forwarding auto-disabled after consecutive failed days'
      : 'S3 forwarding upload failed for a day',
    { orgId: config.orgId, day, s3ConsecutiveFailureCount }
  )
}

async function processOrgS3Day(
  tx: Tx,
  config: S3ConfigRow,
  logger: WorkerLogger | undefined,
  putObject: S3PutObjectFn
): Promise<void> {
  if (!hasS3Credentials(config)) return
  const day = nextDayToForward(config.s3LastForwardedDate)
  // Never forward "today" or a future day — only fully-elapsed UTC days.
  if (day >= toUtcDateString(new Date())) return

  const rows = await fetchDayRows(tx, config.orgId, day)
  if (rows.length === 0) return advanceEmptyDay(tx, config, day, logger)

  const uploaded = await uploadDayBatch(
    config as S3ConfigRow & { s3Bucket: string; s3Region: string; s3AccessKeyId: string },
    day,
    rows,
    putObject
  )
  if (uploaded) return recordS3DaySuccess(tx, config, day)
  return recordS3DayFailure(tx, config, day, logger)
}

/** D3 — the `audit/s3-forward-daily` cron handler. `putObject` defaults to the real S3 client;
 * tests substitute a double. */
export async function runS3ForwardDaily(
  logger?: WorkerLogger,
  putObject: S3PutObjectFn = defaultS3PutObject
): Promise<void> {
  const orgIds = await fetchAllOrgIds()
  for (const orgId of orgIds) {
    try {
      await runOrgScopedJob(orgId, 'audit/s3-forward-daily', async ({ tx }) => {
        const [config] = await tx
          .select()
          .from(auditForwardingConfig)
          .where(and(eq(auditForwardingConfig.orgId, orgId), eq(auditForwardingConfig.type, 's3')))
          .limit(1)
        if (!config?.enabled) return
        await processOrgS3Day(tx, config, logger, putObject)
      })
    } catch (error) {
      if (logger) {
        operationalLog(
          logger,
          'error',
          OperationalEvent.AUDIT_S3_FORWARD_UPLOAD_FAILED,
          'S3 forwarding tick failed for an org',
          { orgId, err: error instanceof Error ? error.message : String(error) }
        )
      }
    }
  }
}
