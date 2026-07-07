import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { OperationalEvent } from '@project-vault/shared'
import { createEventEmitter } from './lib/events.js'
import { createApp } from './app.js'
import { BossService } from './lib/boss.js'
import { registerShutdown } from './lib/shutdown.js'
import {
  loadInitialVaultState,
  setOnVaultUnsealed,
  getVaultStatus,
} from './modules/vault/key-service.js'
import { pruneMfaPendingEnrollments } from './workers/prune-mfa-pending.js'
import { pruneRevokedTokens } from './workers/prune-revoked-tokens.js'
import { pruneTotpUsedCodes } from './workers/prune-totp-used-codes.js'
import { prunePendingMfaSessions } from './workers/prune-pending-mfa-sessions.js'
import { checkFailedAuthThresholdHandler } from './workers/check-failed-auth-threshold.js'
import { checkAnomalousAccessHandler } from './workers/check-anomalous-access.js'
import { healthCheckTickHandler } from './workers/monitoring-health-check.js'
import { pruneFailedAuthAttempts } from './workers/prune-failed-auth-attempts.js'
import { pruneCredentialVersions } from './workers/prune-credential-versions.js'
import { runBreakGlassOverlapExpiryJob } from './workers/rotation-break-glass-expire.js'
import { runStaleRotationRecoveryJob } from './workers/rotation-recover.js'
import { importCleanupExpired } from './workers/import-cleanup.js'
import { runPaymentExpiryAlertJob } from './workers/payment-expiry-alert.js'
import { runCertExpiryAlertJob } from './workers/cert-expiry-alert.js'
import { runDomainExpiryAlertJob } from './workers/domain-expiry-alert.js'
import { runMachineKeyExpiryAlertJob } from './workers/machine-key-expiry-alert.js'
import {
  runMachineKeyOverlapAlertJob,
  runMachineKeyOverlapRevokeJob,
} from './workers/machine-key-overlap-revoke.js'
import { runMachineKeyDormancyCheckJob } from './workers/machine-key-dormancy-check.js'
import {
  notificationEmailCatchupHandler,
  notificationEmailHandler,
} from './workers/notification-email.js'
import {
  notificationSlackCatchupHandler,
  notificationSlackHandler,
} from './workers/notification-slack.js'
import { notificationBackfillHandler } from './workers/notification-backfill.js'
import { notificationDeliverCatchupJobHandler } from './workers/notification-deliver-catchup.js'
import { wrapDeliverHandler } from './workers/notification-deliver.js'
import {
  notificationInboxCatchupHandler,
  notificationInboxPurgeHandler,
} from './workers/notification-inbox-purge.js'
import { notificationDigestHandler } from './workers/notification-digest.js'
import { pruneExpiredAuditLogEntries } from './workers/audit-retention-prune.js'
import { runAuditExport } from './modules/audit/export.js'
import { runWebhookForwardCatchup } from './modules/audit/forwarding.js'
import { runS3ForwardDaily } from './modules/audit/s3-forward.js'
import { backupSnapshotHandler } from './workers/backup-snapshot.js'
import { runBackupHealthCheck } from './workers/backup-health-check.js'
import { isBackupEnabled } from './modules/backup/config.js'
import { reconcileStaleRunningBackups } from './modules/backup/service.js'
import { env } from './config/env.js'
import { instrumentDbPool } from './lib/db-pool-metrics.js'
import { withJobLogging } from './lib/job-logging.js'
import { operationalLog, serializeLogError } from './lib/logger.js'
import { createStartupLogger, logStartupFailure } from './lib/startup-logging.js'
import type { FastifyBaseLogger } from 'fastify'
import postgres from 'postgres'

const NOTIFICATION_CATCHUP_CRON = '*/10 * * * *'
// Story 5.3 AC-8/AC-9 job names, referenced at multiple registration sites below.
const ROTATION_BREAK_GLASS_EXPIRE_JOB = 'rotation:break-glass-expire'
const ROTATION_RECOVER_JOB = 'rotation:recover'

const __dirname = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf-8')) as {
  version: string
}
let startupLogger: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'> | undefined

async function main(): Promise<void> {
  startupLogger = createStartupLogger(env)
  // Architecture mandates this exact startup ORDER:
  // 1. createEventEmitter()
  const emitter = createEventEmitter()

  // 2. createRingBuffer(emitter) — stub in Story 1.1
  const _ringBuffer = null

  const sql = postgres(env.DATABASE_URL)
  const dbPool = instrumentDbPool({
    query: async (statement: string) => sql.unsafe(statement),
  })

  // Check vault state from DB before starting server — throws if DB unreachable (AC-27)
  const initialVaultStatus = await loadInitialVaultState()

  // 3. createApp({ emitter, ringBuffer })
  const fastify = await createApp({
    dbPool,
    vaultGuardEnabled: true,
  })
  fastify.decorate?.('emitter', emitter)
  startupLogger = fastify.log
  operationalLog(
    fastify.log,
    'info',
    OperationalEvent.STARTUP_VAULT_STATUS,
    'Vault status loaded',
    {
      vaultStatus: initialVaultStatus,
    }
  )
  operationalLog(fastify.log, 'info', OperationalEvent.STARTUP_DB_CONNECTED, 'Database reachable')
  if (env.NODE_ENV === 'production' && env.METRICS_BIND_HOST === '0.0.0.0') {
    operationalLog(
      fastify.log,
      'warn',
      OperationalEvent.STARTUP_METRICS_EXPOSED,
      'Metrics endpoint exposed to non-loopback scrapers'
    )
  }

  // 4. registerWorkers(emitter) — pg-boss workers, BossService stub in Story 1.1
  const boss = new BossService(env.DATABASE_URL)
  fastify.decorate?.('boss', boss)
  let bossRegistered = false
  async function startBossAndRegisterWorkers(): Promise<void> {
    await boss.start()
    if (bossRegistered) return
    // Code review fix: reap any `backup_runs` row orphaned by a previous process crashing
    // mid-backup — see reconcileStaleRunningBackups' doc comment. This function only runs on the
    // vault's first unseal event of this process's lifetime (either immediately below if already
    // unsealed at boot, or once via `setOnVaultUnsealed`) and always before `fastify.listen()`,
    // so no request could have raced a real, still-in-flight backup against this reconciliation.
    if (isBackupEnabled()) {
      const reconciledCount = await reconcileStaleRunningBackups()
      if (reconciledCount > 0) {
        operationalLog(
          fastify.log,
          'warn',
          OperationalEvent.BACKUP_FAILED,
          'reconciled stale running backup_runs row(s) orphaned by a previous process crash',
          { reconciledCount }
        )
      }
    }
    await boss.registerSchedules({
      'prune-revoked-tokens': { cron: '0 * * * *' },
      'mfa/prune-totp-used-codes': { cron: '0 * * * *' },
      'mfa/prune-pending-mfa-sessions': { cron: '0 * * * *' },
      'mfa/prune-pending': { cron: '0 0 * * *' },
      'security/check-failed-auth-threshold': { cron: '* * * * *' },
      'security/check-anomalous-access': { cron: '* * * * *' },
      'monitoring/health-check': { cron: '* * * * *' },
      'security/prune-failed-auth-attempts': { cron: '0 2 * * *' },
      'credentials/prune-versions': { cron: '0 3 * * *' },
      [ROTATION_BREAK_GLASS_EXPIRE_JOB]: { cron: '* * * * *' },
      [ROTATION_RECOVER_JOB]: { cron: '*/15 * * * *' },
      'import/cleanup-expired': { cron: '*/5 * * * *' },
      'payment:expiry-alert': { cron: '0 8 * * *' },
      'cert:expiry-alert': { cron: '0 8 * * *' },
      'domain:expiry-alert': { cron: '0 8 * * *' },
      'machine-key:expiry-alert': { cron: '0 8 * * *' },
      // AC-18: split cadence — 5-minute revoke check bounds cron-granularity overshoot to at
      // most 5 minutes even for the shortest permitted overlapMinutes (1); the pre-revocation
      // alert only needs to fire "around" 1 hour ahead, so hourly is sufficient there.
      'machine-key:overlap-revoke': { cron: '*/5 * * * *' },
      'machine-key:overlap-alert': { cron: '0 * * * *' },
      // AC-21: daily dormancy detection job.
      'machine-key:dormancy-check': { cron: '0 9 * * *' },
      'notification:email-catchup': { cron: NOTIFICATION_CATCHUP_CRON },
      'notification:slack-catchup': { cron: NOTIFICATION_CATCHUP_CRON },
      'notification:inbox-catchup': { cron: NOTIFICATION_CATCHUP_CRON },
      'notification:deliver-catchup': { cron: NOTIFICATION_CATCHUP_CRON },
      'notification:inbox-purge': { cron: '0 3 * * *' },
      'notification:send-digest': { cron: `0 ${env.NOTIFICATION_DIGEST_HOUR} * * *` },
      // Story 8.2 D3/D2 — every-minute watermark-cursor catchup (webhook), daily S3 batch, and
      // daily retention prune. `audit:export` is NOT a schedule — it's triggered per-request via
      // boss.send() from POST /audit/export (registered as a worker only, below).
      'audit:webhook-forward-catchup': { cron: '* * * * *' },
      'audit:s3-forward-daily': { cron: '0 1 * * *' },
      'audit:retention-prune': { cron: '0 2 * * *' },
      // Story 9.1 AC-15: backup is opt-in — no schedule registered at all when disabled (env.ts's
      // own validateBackupEnv already guarantees these env vars are consistent when enabled).
      ...(isBackupEnabled()
        ? {
            'backup:snapshot': { cron: env.BACKUP_SCHEDULE },
            'backup:health-check': { cron: '0 * * * *' },
          }
        : {}),
    })
    await boss.registerWorkers({
      'prune-revoked-tokens': () => pruneRevokedTokens(),
      'mfa/prune-totp-used-codes': () => pruneTotpUsedCodes(),
      'mfa/prune-pending-mfa-sessions': () => prunePendingMfaSessions(),
      'mfa/prune-pending': () => pruneMfaPendingEnrollments(),
      'security/check-failed-auth-threshold': () => checkFailedAuthThresholdHandler(boss),
      'security/check-anomalous-access': () => checkAnomalousAccessHandler(boss),
      'monitoring/health-check': () => healthCheckTickHandler(boss, fastify.log),
      'security/prune-failed-auth-attempts': (job) =>
        withJobLogging(
          fastify.log,
          'security/prune-failed-auth-attempts',
          job.id ?? 'unknown',
          () => pruneFailedAuthAttempts()
        ),
      'credentials/prune-versions': (job) =>
        withJobLogging(fastify.log, 'credentials/prune-versions', job.id ?? 'unknown', () =>
          pruneCredentialVersions(fastify.log)
        ),
      [ROTATION_BREAK_GLASS_EXPIRE_JOB]: (job) =>
        withJobLogging(fastify.log, ROTATION_BREAK_GLASS_EXPIRE_JOB, job.id ?? 'unknown', () =>
          runBreakGlassOverlapExpiryJob(fastify.log)
        ),
      [ROTATION_RECOVER_JOB]: (job) =>
        withJobLogging(fastify.log, ROTATION_RECOVER_JOB, job.id ?? 'unknown', () =>
          runStaleRotationRecoveryJob(boss, fastify.log)
        ),
      'import/cleanup-expired': (job) =>
        withJobLogging(fastify.log, 'import/cleanup-expired', job.id ?? 'unknown', () =>
          importCleanupExpired(fastify.log)
        ),
      'payment:expiry-alert': (job) =>
        withJobLogging(fastify.log, 'payment:expiry-alert', job.id ?? 'unknown', () =>
          runPaymentExpiryAlertJob(boss, fastify.log)
        ),
      'cert:expiry-alert': (job) =>
        withJobLogging(fastify.log, 'cert:expiry-alert', job.id ?? 'unknown', () =>
          runCertExpiryAlertJob(boss, fastify.log)
        ),
      'domain:expiry-alert': (job) =>
        withJobLogging(fastify.log, 'domain:expiry-alert', job.id ?? 'unknown', () =>
          runDomainExpiryAlertJob(boss, fastify.log)
        ),
      'machine-key:expiry-alert': (job) =>
        withJobLogging(fastify.log, 'machine-key:expiry-alert', job.id ?? 'unknown', () =>
          runMachineKeyExpiryAlertJob(boss, fastify.log)
        ),
      'machine-key:overlap-revoke': (job) =>
        withJobLogging(fastify.log, 'machine-key:overlap-revoke', job.id ?? 'unknown', () =>
          runMachineKeyOverlapRevokeJob(fastify.log)
        ),
      'machine-key:overlap-alert': (job) =>
        withJobLogging(fastify.log, 'machine-key:overlap-alert', job.id ?? 'unknown', () =>
          runMachineKeyOverlapAlertJob(boss, fastify.log)
        ),
      'machine-key:dormancy-check': (job) =>
        withJobLogging(fastify.log, 'machine-key:dormancy-check', job.id ?? 'unknown', () =>
          runMachineKeyDormancyCheckJob(boss, fastify.log)
        ),
      'notification:email': {
        handler: (job) => notificationEmailHandler(job, fastify.log),
        options: { localConcurrency: 5, localGroupConcurrency: 3 },
      },
      'notification:slack': {
        handler: (job) => notificationSlackHandler(job, fastify.log),
        options: { localConcurrency: 5, localGroupConcurrency: 3 },
      },
      'notification:backfill-pending-delivery': () =>
        notificationBackfillHandler(boss, fastify.log),
      'notification:email-catchup': () => notificationEmailCatchupHandler(boss, fastify.log),
      'notification:slack-catchup': () => notificationSlackCatchupHandler(boss, fastify.log),
      'notification:inbox-catchup': () => notificationInboxCatchupHandler(boss, fastify.log),
      'notification:deliver': {
        handler: (job) => wrapDeliverHandler(fastify.log, emitter)(job),
        options: { localConcurrency: 5, localGroupConcurrency: 3 },
      },
      'notification:deliver-catchup': () => notificationDeliverCatchupJobHandler(boss, fastify.log),
      'notification:inbox-purge': () => notificationInboxPurgeHandler(fastify.log),
      'notification:send-digest': () => notificationDigestHandler(fastify.log),
      // Story 8.2 — audit search/export/forwarding/retention background jobs.
      'audit:export': (job) =>
        withJobLogging(fastify.log, 'audit:export', job.id ?? 'unknown', () =>
          runAuditExport(job.data as { exportId: string; orgId: string })
        ),
      'audit:webhook-forward-catchup': (job) =>
        withJobLogging(fastify.log, 'audit:webhook-forward-catchup', job.id ?? 'unknown', () =>
          runWebhookForwardCatchup(fastify.log)
        ),
      'audit:s3-forward-daily': (job) =>
        withJobLogging(fastify.log, 'audit:s3-forward-daily', job.id ?? 'unknown', () =>
          runS3ForwardDaily(fastify.log)
        ),
      'audit:retention-prune': (job) =>
        withJobLogging(fastify.log, 'audit:retention-prune', job.id ?? 'unknown', () =>
          pruneExpiredAuditLogEntries(fastify.log)
        ),
      // Story 9.1: 'backup:snapshot' is enqueued both by the cron schedule above (job.data
      // empty) and per-request from POST /admin/backup/trigger (job.data carries the runId the
      // route already reserved) — backupSnapshotHandler distinguishes the two (see its own
      // doc comment). Registered unconditionally alongside every other worker: pg-boss requires
      // a worker for a queue it might receive a job on, but if backup is disabled (AC-15) no
      // schedule ever fires and the trigger route itself 503s before ever calling boss.send().
      'backup:snapshot': backupSnapshotHandler(boss, fastify.log),
      'backup:health-check': (job) =>
        withJobLogging(fastify.log, 'backup:health-check', job.id ?? 'unknown', () =>
          runBackupHealthCheck(boss, fastify.log)
        ),
    })
    await boss.send('notification:backfill-pending-delivery', {})
    // Story 5.3 AC-9: startup-once enqueue, deduplicated via singletonKey so a hot-reload/
    // restart never queues a duplicate immediate run alongside the 15-minute cron.
    await boss.send(ROTATION_RECOVER_JOB, {}, { singletonKey: ROTATION_RECOVER_JOB })
    bossRegistered = true
  }
  setOnVaultUnsealed(startBossAndRegisterWorkers)

  fastify.addHook('onReady', async () => {
    // Restart case: already unsealed (e.g. dev hot-reload edge) — start immediately
    if (getVaultStatus() === 'unsealed') await startBossAndRegisterWorkers()
  })
  fastify.addHook('onClose', async () => {
    await boss.stop()
    await sql.end()
  })

  // 5. Wire SIGTERM/SIGINT → graceful shutdown sequence
  registerShutdown(fastify)

  // 6. fastify.listen()
  await fastify.listen({ port: env.API_PORT, host: '0.0.0.0' })
  operationalLog(fastify.log, 'info', OperationalEvent.STARTUP_COMPLETE, 'API startup complete', {
    nodeVersion: process.version,
    serviceVersion: pkg.version,
    vaultStatus: getVaultStatus(),
    dbConnected: true,
    port: env.API_PORT,
  })
}

main().catch((err) => {
  if (startupLogger) {
    void logStartupFailure(startupLogger, err).finally(() => process.exit(1))
  } else {
    process.stderr.write(`Fatal error: ${serializeLogError(err).message}\n`)
    process.exit(1)
  }
})
