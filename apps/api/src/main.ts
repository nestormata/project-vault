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
import {
  notificationEmailCatchupHandler,
  notificationEmailHandler,
} from './workers/notification-email.js'
import {
  notificationSlackCatchupHandler,
  notificationSlackHandler,
} from './workers/notification-slack.js'
import { notificationBackfillHandler } from './workers/notification-backfill.js'
import { env } from './config/env.js'
import { instrumentDbPool } from './lib/db-pool-metrics.js'
import { withJobLogging } from './lib/job-logging.js'
import { operationalLog, serializeLogError } from './lib/logger.js'
import { createStartupLogger, logStartupFailure } from './lib/startup-logging.js'
import type { FastifyBaseLogger } from 'fastify'
import postgres from 'postgres'

const __dirname = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf-8')) as {
  version: string
}
let startupLogger: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'> | undefined

async function main(): Promise<void> {
  startupLogger = createStartupLogger(env)
  // Architecture mandates this exact startup ORDER:
  // 1. createEventEmitter()
  const _emitter = createEventEmitter()

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
      'notification:email-catchup': { cron: '*/10 * * * *' },
      'notification:slack-catchup': { cron: '*/10 * * * *' },
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
