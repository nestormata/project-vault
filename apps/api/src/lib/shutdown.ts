import { OperationalEvent } from '@project-vault/shared'
import type { FastifyApp } from './fastify-app.js'
import { operationalLog } from './logger.js'
import { zeroKeys } from '../modules/vault/key-service.js'

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
      // CRITICAL: zero all in-memory key material FIRST
      // This prevents a process core dump from containing derived key bytes
      zeroKeys()
      await fastify.close()
      operationalLog(fastify.log, 'info', OperationalEvent.SHUTDOWN_COMPLETE, 'Shutdown complete')
      process.exit(0)
    } catch (err) {
      fastify.log.error(err, 'Error during shutdown')
      zeroKeys()
      process.exit(1)
    }
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}
