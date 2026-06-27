import Fastify from 'fastify'
import type { FastifyPluginAsync } from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import { OperationalEvent } from '@project-vault/shared'
import { createLoggerConfig } from '../lib/logger.js'
import { structuredLoggingPlugin } from '../plugins/structured-logging.js'
import { createLogCaptureStream } from './helpers/capture-logs.js'

const initVaultMock = vi.fn()
const unsealVaultMock = vi.fn()

vi.mock('../modules/vault/key-service.js', () => ({
  initVault: initVaultMock,
  unsealVault: unsealVaultMock,
}))

const { vaultRoutes } = await import('../modules/vault/routes.js')

async function flushLogger(logger: unknown): Promise<void> {
  await (logger as { flush?: () => void | Promise<void> }).flush?.()
}

function parseLogLines(lines: string[]): Array<Record<string, unknown>> {
  return lines
    .join('')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

async function createVaultLogTestApp() {
  const { stream, lines } = createLogCaptureStream()
  const app = Fastify({
    logger: {
      ...createLoggerConfig({ NODE_ENV: 'development', LOG_LEVEL: 'info', SERVICE_NAME: 'api' }),
      stream,
    },
    disableRequestLogging: true,
  })
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
    await flushLogger(app.log)

    expect(response.statusCode).toBe(200)
    const vaultLog = parseLogLines(lines).find(
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
