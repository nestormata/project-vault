import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createVaultAgent } from '@project-vault/agent'
import {
  bootstrapRouteIntegrationTest,
  cookieHeader,
  createProjectViaApi,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { createMembershipTestHelpers } from '../../__tests__/helpers/membership-test-helpers.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'
import { bootMachineUserRouteTestApp } from './machine-user-route-test-bootstrap.js'

/**
 * Story 7.3 AC-12's "real end-to-end smoke test" — proves the underlying flow `vault-action`
 * wraps actually works end-to-end against a REAL, listening HTTP server (not Fastify's
 * `app.inject()`, which every other route-integration test in this module uses). This complements
 * (does not replace) `packages/vault-action`'s own mocked unit tests, which verify the
 * Action-specific wiring (masking order, `continue-on-error` semantics, cross-project validation)
 * in isolation with a mocked `@project-vault/agent`.
 *
 * `@project-vault/agent` is imported directly (not through `packages/vault-action`), since the
 * Action's own entry point is designed to run inside the GitHub Actions runtime, not a generic
 * Vitest/Node test harness.
 */

const { createApp, initVault } = await bootstrapRouteIntegrationTest()
type TestApp = Awaited<ReturnType<typeof createApp>>

const { registerOwner } = createMembershipTestHelpers({
  emailPrefix: 'vault-action-e2e',
  orgNamePrefix: 'Vault Action E2E',
})

function machineUsersUrl(projectId: string): string {
  return `/api/v1/projects/${projectId}/machine-users`
}
function apiKeysUrl(machineUserId: string): string {
  return `/api/v1/machine-users/${machineUserId}/api-keys`
}

async function issueMachineUserAndKey(
  app: TestApp,
  cookies: Record<string, string>,
  projectId: string
): Promise<string> {
  const muRes = await app.inject({
    method: 'POST',
    url: machineUsersUrl(projectId),
    headers: { cookie: cookieHeader(cookies) },
    payload: { name: `bot-${randomUUID().slice(0, 8)}`, role: 'member' },
  })
  expect(muRes.statusCode).toBe(201)
  const machineUserId = muRes.json<{ data: { id: string } }>().data.id

  const keyRes = await app.inject({
    method: 'POST',
    url: apiKeysUrl(machineUserId),
    headers: { cookie: cookieHeader(cookies) },
    payload: { name: 'vault-action-e2e-key' },
  })
  expect(keyRes.statusCode).toBe(201)
  return keyRes.json<{ data: { key: string } }>().data.key
}

async function createCredentialViaApi(
  app: TestApp,
  cookies: Record<string, string>,
  projectId: string,
  name: string,
  value: string
): Promise<void> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/projects/${projectId}/credentials`,
    headers: { cookie: cookieHeader(cookies) },
    payload: { name, value },
  })
  expect(res.statusCode).toBe(201)
}

describe('AC-12 real end-to-end smoke test: @project-vault/agent against a live HTTP server', () => {
  let app: TestApp
  let baseUrl: string

  beforeAll(async () => {
    app = await bootMachineUserRouteTestApp(createApp, initVault)
    // Fastify's listen() resolves the actual bound address (e.g. "http://127.0.0.1:54321") when
    // port 0 requests an OS-assigned free port — used directly as @project-vault/agent's baseUrl.
    baseUrl = await app.listen({ port: 0, host: '127.0.0.1' })
  })

  afterAll(async () => {
    await app.close()
    await resetVaultForTest()
  })

  it('retrieves a real credential value through the real machine-token exchange + credential-value routes', async () => {
    const owner = await registerOwner(app, 'happy-path')
    const projectId = await createProjectViaApi(app, owner.cookies, 'vault-action-e2e-happy')
    await createCredentialViaApi(
      app,
      owner.cookies,
      projectId,
      'DATABASE_URL',
      'postgres://real-e2e-value'
    )
    const apiKey = await issueMachineUserAndKey(app, owner.cookies, projectId)

    const agent = createVaultAgent({ apiKey, baseUrl, projectId })
    const value = await agent.getSecret('DATABASE_URL')

    expect(value).toBe('postgres://real-e2e-value')
  })

  it('rejects a revoked/invalid api key with the same VaultAgentError the action classifies as an application-level failure', async () => {
    const owner = await registerOwner(app, 'invalid-key')
    const projectId = await createProjectViaApi(app, owner.cookies, 'vault-action-e2e-invalid')

    const agent = createVaultAgent({ apiKey: 'pk_not_a_real_key', baseUrl, projectId })

    await expect(agent.getSecret('DATABASE_URL')).rejects.toMatchObject({
      code: 'token_exchange_failed',
    })
  })
})
