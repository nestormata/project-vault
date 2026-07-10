import { and, asc, eq, or, gt } from 'drizzle-orm'
import type { EncryptedValue } from '@project-vault/crypto'
import { withSecret } from '@project-vault/crypto'
import type { Tx } from '@project-vault/db'
import { auditForwardingConfig, auditLogEntries } from '@project-vault/db/schema'
import { OperationalEvent } from '@project-vault/shared'
import type { FastifyBaseLogger } from 'fastify'
import { encryptValue } from '../../lib/encrypt-value.js'
import { operationalLog } from '../../lib/logger.js'
import {
  assertPublicHostname,
  safeFetchExternal,
  type SafeFetchResult,
} from '../../lib/safe-fetch.js'
import { fetchAllOrgIds, runOrgScopedJob } from '../../middleware/rls.js'
import { applyForwardingConfigUpdate } from './forwarding-config-update.js'

/** Injectable so tests can substitute a delivery double instead of making a real, SSRF-guarded
 * network call (which would itself reject a local test-server loopback address). Defaults to the
 * real safeFetchExternal in production. */
export type WebhookDeliverFn = (
  url: string,
  init: { method: string; headers?: Record<string, string>; body?: string }
) => Promise<SafeFetchResult>

/** D3 — after this many consecutive delivery failures on the same (blocking) row, the org's
 * webhook forwarding is auto-disabled rather than retried forever. */
export const AUDIT_WEBHOOK_MAX_CONSECUTIVE_FAILURES = 10
/** D3 — per-tick batch size for the watermark-cursor catchup cron. */
export const AUDIT_WEBHOOK_FORWARD_BATCH_SIZE = 500

type WorkerLogger = Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>

export type WebhookForwardingInput = { url: string; secretHeader: string }
export type S3ForwardingInput = {
  bucket: string
  prefix?: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  endpoint?: string
}

export type ForwardingConfigResult = {
  type: 'webhook' | 's3'
  enabled: boolean
  configuredAt: string
}

const CLEAR_WEBHOOK_FIELDS = {
  webhookUrl: null,
  webhookSecretEncrypted: null,
  lastForwardedCreatedAt: null,
  lastForwardedId: null,
  consecutiveFailureCount: 0,
}

const CLEAR_S3_FIELDS = {
  s3Bucket: null,
  s3Prefix: null,
  s3Region: null,
  s3AccessKeyId: null,
  s3SecretAccessKeyEncrypted: null,
  s3Endpoint: null,
  s3LastForwardedDate: null,
  s3ConsecutiveFailureCount: 0,
}

/**
 * AC-17 — upserts the org's forwarding config wholesale: switching `type` fully replaces the
 * prior config (the other type's fields are cleared, not left stale alongside the new one).
 * SSRF-validates the webhook `url` / S3 `endpoint` via assertPublicHostname() before the row is
 * upserted (D4).
 */
export async function configureForwarding(
  tx: Tx,
  orgId: string,
  input:
    { type: 'webhook'; config: WebhookForwardingInput } | { type: 's3'; config: S3ForwardingInput }
): Promise<ForwardingConfigResult> {
  const now = new Date()

  if (input.type === 'webhook') {
    await assertPublicHostname(input.config.url)
    const webhookSecretEncrypted = await encryptValue(input.config.secretHeader)
    const values = {
      orgId,
      type: 'webhook' as const,
      enabled: true,
      webhookUrl: input.config.url,
      webhookSecretEncrypted,
      lastForwardedCreatedAt: null,
      lastForwardedId: null,
      consecutiveFailureCount: 0,
      ...CLEAR_S3_FIELDS,
      configuredAt: now,
      updatedAt: now,
    }
    await tx
      .insert(auditForwardingConfig)
      .values(values)
      .onConflictDoUpdate({ target: auditForwardingConfig.orgId, set: values })
    return { type: 'webhook', enabled: true, configuredAt: now.toISOString() }
  }

  if (input.config.endpoint) {
    await assertPublicHostname(input.config.endpoint)
  }
  const s3SecretAccessKeyEncrypted = await encryptValue(input.config.secretAccessKey)
  const values = {
    orgId,
    type: 's3' as const,
    enabled: true,
    ...CLEAR_WEBHOOK_FIELDS,
    s3Bucket: input.config.bucket,
    s3Prefix: input.config.prefix ?? null,
    s3Region: input.config.region,
    s3AccessKeyId: input.config.accessKeyId,
    s3SecretAccessKeyEncrypted,
    s3Endpoint: input.config.endpoint ?? null,
    s3LastForwardedDate: null,
    s3ConsecutiveFailureCount: 0,
    configuredAt: now,
    updatedAt: now,
  }
  await tx
    .insert(auditForwardingConfig)
    .values(values)
    .onConflictDoUpdate({ target: auditForwardingConfig.orgId, set: values })
  return { type: 's3', enabled: true, configuredAt: now.toISOString() }
}

type WebhookConfigRow = typeof auditForwardingConfig.$inferSelect

type AuditRow = typeof auditLogEntries.$inferSelect

function buildWebhookCursorCondition(config: WebhookConfigRow) {
  if (!config.lastForwardedCreatedAt || !config.lastForwardedId) return undefined
  return or(
    gt(auditLogEntries.createdAt, config.lastForwardedCreatedAt),
    and(
      eq(auditLogEntries.createdAt, config.lastForwardedCreatedAt),
      gt(auditLogEntries.id, config.lastForwardedId)
    )
  )
}

async function fetchPendingWebhookRows(tx: Tx, config: WebhookConfigRow): Promise<AuditRow[]> {
  return tx
    .select()
    .from(auditLogEntries)
    .where(buildWebhookCursorCondition(config))
    .orderBy(asc(auditLogEntries.createdAt), asc(auditLogEntries.id))
    .limit(AUDIT_WEBHOOK_FORWARD_BATCH_SIZE)
}

async function attemptWebhookDelivery(
  webhookUrl: string,
  secretHeader: string,
  row: AuditRow,
  deliver: WebhookDeliverFn
): Promise<boolean> {
  try {
    const result = await deliver(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Audit-Webhook-Secret': secretHeader },
      body: JSON.stringify({
        id: row.id,
        orgId: row.orgId,
        eventType: row.eventType,
        actorTokenId: row.actorTokenId,
        actorType: row.actorType,
        resourceId: row.resourceId,
        resourceType: row.resourceType,
        projectId: row.projectId,
        ipAddress: row.ipAddress,
        createdAt: row.createdAt.toISOString(),
      }),
    })
    return result.ok
  } catch {
    return false
  }
}

/** Records a failed row delivery: increments the failure count, auto-disables past the
 * threshold, and logs. Returns nothing — the caller always stops processing after a failure
 * (strictly sequential, never skips ahead past a failed row). */
async function recordWebhookFailure(
  tx: Tx,
  config: WebhookConfigRow,
  consecutiveFailureCount: number,
  rowId: string,
  logger: WorkerLogger | undefined
): Promise<void> {
  const disable = consecutiveFailureCount >= AUDIT_WEBHOOK_MAX_CONSECUTIVE_FAILURES
  await applyForwardingConfigUpdate(tx, config.orgId, {
    consecutiveFailureCount,
    enabled: disable ? false : config.enabled,
  })
  if (!logger) return
  operationalLog(
    logger,
    disable ? 'error' : 'warn',
    disable
      ? OperationalEvent.AUDIT_WEBHOOK_FORWARD_DISABLED
      : OperationalEvent.AUDIT_WEBHOOK_FORWARD_ROW_FAILED,
    disable
      ? 'Webhook forwarding auto-disabled after consecutive failures'
      : 'Webhook forwarding row delivery failed',
    { orgId: config.orgId, consecutiveFailureCount, rowId }
  )
}

async function recordWebhookSuccess(
  tx: Tx,
  config: WebhookConfigRow,
  row: AuditRow
): Promise<void> {
  await tx
    .update(auditForwardingConfig)
    .set({
      lastForwardedCreatedAt: row.createdAt,
      lastForwardedId: row.id,
      consecutiveFailureCount: 0,
      updatedAt: new Date(),
    })
    .where(eq(auditForwardingConfig.orgId, config.orgId))
}

/** AC-18 — processes exactly one org's webhook catchup tick: fetches up to
 * AUDIT_WEBHOOK_FORWARD_BATCH_SIZE not-yet-forwarded rows (strict created_at,id order), POSTs
 * each in order, and stops at the first failure (never skips ahead past a failed row). */
async function processOrgWebhookTick(
  tx: Tx,
  config: WebhookConfigRow,
  logger: WorkerLogger | undefined,
  deliver: WebhookDeliverFn
): Promise<void> {
  if (!config.webhookUrl || !config.webhookSecretEncrypted) return
  const webhookUrl = config.webhookUrl
  const rows = await fetchPendingWebhookRows(tx, config)

  let consecutiveFailureCount = config.consecutiveFailureCount

  for (const row of rows) {
    const secretHeader = await withSecret(
      config.webhookSecretEncrypted as unknown as EncryptedValue,
      (plaintext) => Promise.resolve(plaintext.toString('utf8'))
    )
    const delivered = await attemptWebhookDelivery(webhookUrl, secretHeader, row, deliver)

    if (!delivered) {
      consecutiveFailureCount += 1
      await recordWebhookFailure(tx, config, consecutiveFailureCount, row.id, logger)
      return // strictly sequential — never skip ahead past a failed row
    }

    consecutiveFailureCount = 0
    await recordWebhookSuccess(tx, config, row)
  }
}

/** D3 — the `audit/webhook-forward-catchup` cron handler: iterates every org, processing only
 * those with an enabled webhook config. `deliver` defaults to the real SSRF-guarded
 * safeFetchExternal; tests substitute a double. */
export async function runWebhookForwardCatchup(
  logger?: WorkerLogger,
  deliver: WebhookDeliverFn = safeFetchExternal
): Promise<void> {
  const orgIds = await fetchAllOrgIds()
  for (const orgId of orgIds) {
    try {
      await runOrgScopedJob(orgId, 'audit/webhook-forward-catchup', async ({ tx }) => {
        const [config] = await tx
          .select()
          .from(auditForwardingConfig)
          .where(
            and(eq(auditForwardingConfig.orgId, orgId), eq(auditForwardingConfig.type, 'webhook'))
          )
          .limit(1)
        if (!config?.enabled) return
        await processOrgWebhookTick(tx, config, logger, deliver)
      })
    } catch (error) {
      // One org's failure (e.g. a corrupt/undecryptable secret) must never block every other
      // org's catchup tick from running.
      if (logger) {
        operationalLog(
          logger,
          'error',
          OperationalEvent.AUDIT_WEBHOOK_FORWARD_ROW_FAILED,
          'Webhook forwarding tick failed for an org',
          { orgId, err: error instanceof Error ? error.message : String(error) }
        )
      }
    }
  }
}
