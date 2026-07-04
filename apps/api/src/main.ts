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
import { pruneFailedAuthAttempts } from './workers/prune-failed-auth-attempts.js'
import { pruneCredentialVersions } from './workers/prune-credential-versions.js'
import { importCleanupExpired } from './workers/import-cleanup.js'
import { runPaymentExpiryAlertJob } from './workers/payment-expiry-alert.js'
import { runCertExpiryAlertJob } from './workers/cert-expiry-alert.js'
import { runDomainExpiryAlertJob } from './workers/domain-expiry-alert.js'
import { runMachineKeyExpiryAlertJob } from './workers/machine-key-expiry-alert.js'
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
import { env } from './config/env.js'
import { instrumentDbPool } from './lib/db-pool-metrics.js'
import { withJobLogging } from './lib/job-logging.js'
import { operationalLog, serializeLogError } from './lib/logger.js'
import { createStartupLogger, logStartupFailure } from './lib/startup-logging.js'
import type { FastifyBaseLogger } from 'fastify'
import postgres from 'postgres'

const NOTIFICATION_CATCHUP_CRON = '*/10 * * * *'

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
    await boss.registerSchedules({
      'prune-revoked-tokens': { cron: '0 * * * *' },
      'mfa/prune-totp-used-codes': { cron: '0 * * * *' },
      'mfa/prune-pending-mfa-sessions': { cron: '0 * * * *' },
      'mfa/prune-pending': { cron: '0 0 * * *' },
      'security/check-failed-auth-threshold': { cron: '* * * * *' },
      'security/prune-failed-auth-attempts': { cron: '0 2 * * *' },
      'credentials/prune-versions': { cron: '0 3 * * *' },
      'import/cleanup-expired': { cron: '*/5 * * * *' },
      'payment:expiry-alert': { cron: '0 8 * * *' },
      'cert:expiry-alert': { cron: '0 8 * * *' },
      'domain:expiry-alert': { cron: '0 8 * * *' },
      'machine-key:expiry-alert': { cron: '0 8 * * *' },
      'notification:email-catchup': { cron: NOTIFICATION_CATCHUP_CRON },
      'notification:slack-catchup': { cron: NOTIFICATION_CATCHUP_CRON },
      'notification:inbox-catchup': { cron: NOTIFICATION_CATCHUP_CRON },
      'notification:deliver-catchup': { cron: NOTIFICATION_CATCHUP_CRON },
      'notification:inbox-purge': { cron: '0 3 * * *' },
      'notification:send-digest': { cron: `0 ${env.NOTIFICATION_DIGEST_HOUR} * * *` },
    })
    await boss.registerWorkers({
      'prune-revoked-tokens': () => pruneRevokedTokens(),
      'mfa/prune-totp-used-codes': () => pruneTotpUsedCodes(),
      'mfa/prune-pending-mfa-sessions': () => prunePendingMfaSessions(),
      'mfa/prune-pending': () => pruneMfaPendingEnrollments(),
      'security/check-failed-auth-threshold': () => checkFailedAuthThresholdHandler(boss),
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
    })
    await boss.send('notification:backfill-pending-delivery', {})
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
