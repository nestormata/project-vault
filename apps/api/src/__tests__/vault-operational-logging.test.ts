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

const INIT_URL = '/api/v1/vault/init'
const UNSEAL_URL = '/api/v1/vault/unseal'

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
      url: INIT_URL,
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

  // Story 1.14 AC-18 positive example: the kms init log line shows the KMS ARN unredacted.
  it('emits the KMS key ARN unredacted in the vault.init log line for kms-mode init', async () => {
    initVaultMock.mockResolvedValueOnce({
      initialized: true,
      keyVersion: 1,
      kmsType: 'kms',
    })
    const { app, lines } = await createVaultLogTestApp()
    const keyId = 'arn:aws:kms:us-east-1:123456789012:key/abcd-1234-efgh-5678-ijkl90mnopqr'

    const response = await app.inject({
      method: 'POST',
      url: INIT_URL,
      payload: { kmsType: 'kms', kmsKeyId: keyId },
    })
    await flushCapturedLogger(app.log)

    expect(response.statusCode).toBe(200)
    const vaultLog = parseCapturedLogLines(lines).find(
      (line) => line.message === 'Vault initialized successfully'
    )
    expect(vaultLog).toMatchObject({
      eventType: OperationalEvent.VAULT_INIT,
      kmsType: 'kms',
      body: { kmsType: 'kms', kmsKeyId: keyId },
    })

    await app.close()
  })

  // Story 1.14 AC-18 negative example: a kms-mode init/unseal failure never logs KMS ciphertext
  // or plaintext key material — only the AppError's sanitized code, same as every other mode.
  it('never logs KMS ciphertext/plaintext material on a kms-mode init or unseal failure', async () => {
    const { AppError } = await import('../lib/errors.js')
    initVaultMock.mockRejectedValueOnce(
      new AppError(
        'KMS_PERMISSION_DENIED',
        "The API's AWS credentials do not have permission to use the configured KMS key.",
        403
      )
    )
    unsealVaultMock.mockRejectedValueOnce(
      new AppError(
        'KMS_KEY_UNAVAILABLE',
        'The KMS key required to unseal this vault is not currently usable.',
        503
      )
    )
    const { app, lines } = await createVaultLogTestApp()

    const initRes = await app.inject({
      method: 'POST',
      url: INIT_URL,
      payload: { kmsType: 'kms', kmsKeyId: 'arn:aws:kms:us-east-1:123456789012:key/fake' },
    })
    const unsealRes = await app.inject({ method: 'POST', url: UNSEAL_URL, payload: {} })
    await flushCapturedLogger(app.log)

    expect(initRes.statusCode).toBe(403)
    expect(unsealRes.statusCode).toBe(503)
    const logged = lines.join('\n')
    expect(logged).not.toMatch(/ZmFrZS1jaXBoZXJ0ZXh0|CiphertextBlob|Plaintext/)

    await app.close()
  })
})
