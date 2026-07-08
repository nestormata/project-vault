import Fastify from 'fastify'
import type { FastifyPluginAsync } from 'fastify'
import { serializerCompiler, validatorCompiler } from '@fastify/type-provider-zod'
import { describe, expect, it, vi } from 'vitest'
import { OperationalEvent } from '@project-vault/shared'
import { createLoggerConfig } from '../lib/logger.js'
import { structuredLoggingPlugin } from '../plugins/structured-logging.js'
import {
  createLogCaptureStream,
  flushCapturedLogger,
  parseCapturedLogLines,
} from './helpers/capture-logs.js'

const initVaultMock = vi.fn()
const unsealVaultMock = vi.fn()

vi.mock('../modules/vault/key-service.js', () => ({
  initVault: initVaultMock,
  unsealVault: unsealVaultMock,
}))

const { vaultRoutes } = await import('../modules/vault/routes.js')

async function createVaultLogTestApp() {
  const { stream, lines } = createLogCaptureStream()
  const app = Fastify({
    logger: {
      ...createLoggerConfig({ NODE_ENV: 'development', LOG_LEVEL: 'info', SERVICE_NAME: 'api' }),
      stream,
    },
    disableRequestLogging: true,
  })
  // vaultRoutes now declares real Zod schema.response maps (see apps/api/src/modules/vault/routes.ts) —
  // without these compilers Fastify falls back to its default ajv-based schema handling, which
  // chokes on a raw Zod schema object ("data/required must be array"). app.ts registers these globally;
  // this standalone test harness needs its own copy since it builds a bare Fastify() instance.
  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)
  await app.register(structuredLoggingPlugin)
  await app.register(vaultRoutes as unknown as FastifyPluginAsync)
  return { app, lines }
}

describe('vault operational logging', () => {
  it('emits vault.init using eventType instead of the legacy event key', async () => {
    initVaultMock.mockResolvedValueOnce({
      initialized: true,
      keyVersion: 1,
      kmsType: 'passphrase',
    })
    const { app, lines } = await createVaultLogTestApp()

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/vault/init',
      payload: { kmsType: 'passphrase', passphrase: 'test-passphrase-12chars' },
    })
    await flushCapturedLogger(app.log)

    expect(response.statusCode).toBe(200)
    const vaultLog = parseCapturedLogLines(lines).find(
      (line) => line.message === 'Vault initialized successfully'
    )
    expect(vaultLog).toMatchObject({
      eventType: OperationalEvent.VAULT_INIT,
      keyVersion: 1,
      kmsType: 'passphrase',
    })
    expect(vaultLog).not.toHaveProperty('event')

    await app.close()
  })
})
