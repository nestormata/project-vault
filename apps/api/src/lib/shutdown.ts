import type { FastifyApp } from './fastify-app.js'
import { zeroKeys } from '../modules/vault/key-service.js'

export function registerShutdown(fastify: FastifyApp): void {
  const shutdown = async (signal: string): Promise<void> => {
    fastify.log.info({ signal }, 'Received shutdown signal')
    try {
      // CRITICAL: zero all in-memory key material FIRST
      // This prevents a process core dump from containing derived key bytes
      zeroKeys()
      await fastify.close()
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
