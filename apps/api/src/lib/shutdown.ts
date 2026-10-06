import { OperationalEvent } from '@project-vault/shared'
import type { FastifyApp } from './fastify-app.js'
import { operationalLog, serializeLogError } from './logger.js'
import { zeroKeys } from '../modules/vault/key-service.js'
import { flushPendingLosingAttempts } from '../modules/credential-shares/external-service.js'

// Story 65.4: bounded wait for deferred external-share losing-attempt writes (AC-22 counter) so a
// graceful stop does not drop them; a stuck write can never hold the shutdown past this.
export const LOSING_ATTEMPT_DRAIN_TIMEOUT_MS = 3000

export function registerShutdown(fastify: FastifyApp): void {
  const shutdown = async (signal: string): Promise<void> => {
    operationalLog(
      fastify.log,
      'info',
      OperationalEvent.SHUTDOWN_SIGNAL,
      'Received shutdown signal',
      { signal }
    )
    try {
      // Drain before zeroing: the deferred lazy-expiry audit write may need key material.
      await flushPendingLosingAttempts(LOSING_ATTEMPT_DRAIN_TIMEOUT_MS)
      // CRITICAL: zero all in-memory key material FIRST (right after the bounded drain above)
      // This prevents a process core dump from containing derived key bytes
      zeroKeys()
      await fastify.close()
      operationalLog(fastify.log, 'info', OperationalEvent.SHUTDOWN_COMPLETE, 'Shutdown complete')
      process.exit(0)
    } catch (err) {
      operationalLog(fastify.log, 'error', OperationalEvent.SHUTDOWN_FAILED, 'Shutdown failed', {
        err: serializeLogError(err),
      })
      zeroKeys()
      process.exit(1)
    }
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}
