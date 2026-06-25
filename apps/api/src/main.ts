import { createEventEmitter } from './lib/events.js'
import { createApp } from './app.js'
import { BossService } from './lib/boss.js'
import { registerShutdown } from './lib/shutdown.js'
import {
  loadInitialVaultState,
  setOnVaultUnsealed,
  getVaultStatus,
} from './modules/vault/key-service.js'
import { env } from './config/env.js'
import postgres from 'postgres'

async function main(): Promise<void> {
  // Architecture mandates this exact startup ORDER:
  // 1. createEventEmitter()
  const _emitter = createEventEmitter()

  // 2. createRingBuffer(emitter) — stub in Story 1.1
  const _ringBuffer = null

  const sql = postgres(env.DATABASE_URL)

  // Check vault state from DB before starting server — throws if DB unreachable (AC-27)
  const initialVaultStatus = await loadInitialVaultState()
  process.stderr.write(`[vault] Initial status: ${initialVaultStatus}\n`)

  // 3. createApp({ emitter, ringBuffer })
  const fastify = await createApp({
    dbPool: {
      query: async (statement: string) => sql.unsafe(statement),
    },
    vaultGuardEnabled: true,
  })

  // 4. registerWorkers(emitter) — pg-boss workers, BossService stub in Story 1.1
  const boss = new BossService(env.DATABASE_URL)
  setOnVaultUnsealed(async () => {
    await boss.start()
  })

  fastify.addHook('onReady', async () => {
    // Restart case: already unsealed (e.g. dev hot-reload edge) — start immediately
    if (getVaultStatus() === 'unsealed') await boss.start()
  })
  fastify.addHook('onClose', async () => {
    await boss.stop()
    await sql.end()
  })

  // 5. Wire SIGTERM/SIGINT → graceful shutdown sequence
  registerShutdown(fastify)

  // 6. fastify.listen()
  await fastify.listen({ port: env.API_PORT, host: '0.0.0.0' })
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${String(err)}\n`)
  process.exit(1)
})
