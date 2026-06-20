import type { FastifyApp } from './fastify-app.js'

export function registerShutdown(fastify: FastifyApp): void {
  const shutdown = async (signal: string): Promise<void> => {
    fastify.log.info({ signal }, 'Received shutdown signal')
    try {
      await fastify.close()
      process.exit(0)
    } catch (err) {
      fastify.log.error(err, 'Error during shutdown')
      process.exit(1)
    }
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}
