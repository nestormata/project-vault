/**
 * Story 43.1 Testing requirements — "Integration/E2E test proving the CLI genuinely round-trips
 * against a real (or realistically faked) server". Direct precedent for this shape:
 * apps/api/src/modules/machine-users/vault-action-agent-e2e.test.ts (the same idea for
 * packages/vault-action). This boots a REAL, listening `@project-vault/api` HTTP server (not
 * Fastify's `app.inject()`) and drives this package's own `runGet()` against it with real env-var
 * config, so `@project-vault/agent`'s `fetch()` calls travel over a real socket end to end.
 *
 * Requires a real, migrated Postgres reachable via DATABASE_URL/ADMIN_DATABASE_URL — same
 * requirement as packages/api-contract-tests. See packages/cli/README.md "Running the e2e test"
 * for local setup.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import postgres from 'postgres'
import { createApp } from '@project-vault/api/app'
import { runGet } from './get-command.js'
import { resolveConfig } from './config.js'

type TestApp = Awaited<ReturnType<typeof createApp>>

const E2E_VAULT_SECRET = 'cli-e2e-vault-passphrase-32-characters-long'

function cookieHeader(jar: Record<string, string>): string {
  return Object.entries(jar)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ')
}

/** Mirrors packages/api-contract-tests/src/fixtures/http.ts's describeResponse() — Fastify's
 * inject-response type only exposes `.json<T>()`, not a raw body string. */
function describeResponse(res: { statusCode: number; json<T>(): T }): string {
  try {
    return `${res.statusCode} ${JSON.stringify(res.json())}`
  } catch {
    return `${res.statusCode} (non-JSON body)`
  }
}

function parseSetCookies(setCookie: string | string[] | undefined): Record<string, string> {
  const headers: string[] = setCookie ? ([] as string[]).concat(setCookie) : []
  return Object.fromEntries(
    headers
      .map((header) => header.split(';')[0] ?? '')
      .filter(Boolean)
      .map((cookie) => {
        const [name, ...rest] = cookie.split('=')
        return [name, rest.join('=')]
      })
  )
}

/**
 * Bypasses `vault_state`'s append-only trigger the same way
 * packages/api-contract-tests/src/fixtures/app-instance.ts's own resetVaultState() does, via the
 * test-only `app.vault_test_reset` GUC — needed because vault_state is process-independent
 * (stored in Postgres), so a prior suite run (or packages/api-contract-tests itself) may have
 * already initialized it under a different passphrase.
 */
async function resetVaultState(): Promise<void> {
  const sql = postgres(process.env['DATABASE_URL'] as string)
  try {
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.vault_test_reset', 'true', true)`
      await tx`DELETE FROM vault_state`
    })
  } finally {
    await sql.end()
  }
}

async function registerLoginAndInitVault(app: TestApp): Promise<Record<string, string>> {
  const email = `cli-e2e-${randomUUID()}@example.com`
  const password = 'cli-e2e-correct-horse-battery-staple'

  const initRes = await app.inject({
    method: 'POST',
    url: '/api/v1/vault/init',
    payload: { kmsType: 'passphrase', passphrase: E2E_VAULT_SECRET },
  })
  if (initRes.statusCode !== 200 && initRes.statusCode !== 409) {
    throw new Error(`e2e fixture: vault init failed: ${describeResponse(initRes)}`)
  }
  if (initRes.statusCode === 409) {
    const unsealRes = await app.inject({
      method: 'POST',
      url: '/api/v1/vault/unseal',
      payload: { passphrase: E2E_VAULT_SECRET },
    })
    if (unsealRes.statusCode !== 200) {
      throw new Error(`e2e fixture: vault unseal failed: ${describeResponse(unsealRes)}`)
    }
  }

  const registerRes = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { email, password, orgName: `CLI E2E Org ${randomUUID()}` },
  })
  if (registerRes.statusCode !== 202) {
    throw new Error(`e2e fixture: register failed: ${describeResponse(registerRes)}`)
  }

  const loginRes = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password },
  })
  if (loginRes.statusCode !== 200) {
    throw new Error(`e2e fixture: login failed: ${describeResponse(loginRes)}`)
  }

  return parseSetCookies(loginRes.headers['set-cookie'])
}

async function createProjectAndCredential(
  app: TestApp,
  cookies: Record<string, string>,
  name: string,
  value: string
): Promise<string> {
  const slug = `cli-e2e-${randomUUID().slice(0, 8)}`
  const projectRes = await app.inject({
    method: 'POST',
    url: '/api/v1/projects',
    headers: { cookie: cookieHeader(cookies) },
    payload: { name: `CLI E2E Project ${slug}`, slug },
  })
  if (projectRes.statusCode !== 201) {
    throw new Error(`e2e fixture: project creation failed: ${describeResponse(projectRes)}`)
  }
  const projectId = projectRes.json<{ data: { id: string } }>().data.id

  const credentialRes = await app.inject({
    method: 'POST',
    url: `/api/v1/projects/${projectId}/credentials`,
    headers: { cookie: cookieHeader(cookies) },
    payload: { name, value },
  })
  if (credentialRes.statusCode !== 201) {
    throw new Error(`e2e fixture: credential creation failed: ${describeResponse(credentialRes)}`)
  }

  return projectId
}

async function issueMachineUserApiKey(
  app: TestApp,
  cookies: Record<string, string>,
  projectId: string
): Promise<string> {
  const muRes = await app.inject({
    method: 'POST',
    url: `/api/v1/projects/${projectId}/machine-users`,
    headers: { cookie: cookieHeader(cookies) },
    payload: { name: `cli-e2e-bot-${randomUUID().slice(0, 8)}`, role: 'member' },
  })
  if (muRes.statusCode !== 201) {
    throw new Error(`e2e fixture: machine user creation failed: ${describeResponse(muRes)}`)
  }
  const machineUserId = muRes.json<{ data: { id: string } }>().data.id

  const keyRes = await app.inject({
    method: 'POST',
    url: `/api/v1/machine-users/${machineUserId}/api-keys`,
    headers: { cookie: cookieHeader(cookies) },
    payload: { name: 'cli-e2e-key' },
  })
  if (keyRes.statusCode !== 201) {
    throw new Error(`e2e fixture: api key issuance failed: ${describeResponse(keyRes)}`)
  }
  return keyRes.json<{ data: { key: string } }>().data.key
}

describe('runGet — real end-to-end round trip against a live @project-vault/api server', () => {
  let app: TestApp
  let baseUrl: string
  let projectId: string
  let apiKey: string
  const credentialName = 'CLI_E2E_DATABASE_URL'
  const credentialValue = 'postgres://cli-e2e-real-value'

  beforeAll(async () => {
    process.env['DATABASE_URL'] ??=
      'postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault'
    process.env['CORS_ALLOWED_ORIGINS'] ??= 'http://localhost:5173'
    process.env['VAULT_ALLOW_REMOTE_INIT'] = 'true'
    process.env['RATE_LIMIT_TEST_BYPASS'] = 'true'

    await resetVaultState()

    app = await createApp({ logger: false })
    await app.ready()

    const cookies = await registerLoginAndInitVault(app)
    projectId = await createProjectAndCredential(app, cookies, credentialName, credentialValue)
    apiKey = await issueMachineUserApiKey(app, cookies, projectId)

    baseUrl = await app.listen({ port: 0, host: '127.0.0.1' })
  })

  afterAll(async () => {
    await app.close()
  })

  it('fetches the real seeded secret value over a real HTTP round trip', async () => {
    const config = resolveConfig({ apiKey, url: baseUrl, projectId }, {})
    const stdoutChunks: string[] = []
    const stderrChunks: string[] = []

    const exitCode = await runGet(
      { name: credentialName, stdout: false },
      config,
      {
        stdout: { write: (chunk) => void stdoutChunks.push(chunk) },
        stderr: { write: (chunk) => void stderrChunks.push(chunk) },
        isTTY: false,
      },
      { createVaultAgent: (await import('@project-vault/agent')).createVaultAgent }
    )

    expect(exitCode).toBe(0)
    expect(stdoutChunks.join('')).toBe(credentialValue)
    expect(stderrChunks.join('')).toBe('')
  })

  it('exits with the distinguishable credential_not_found exit code for a real 404 from the live server', async () => {
    const config = resolveConfig({ apiKey, url: baseUrl, projectId }, {})
    const stdoutChunks: string[] = []
    const stderrChunks: string[] = []

    const exitCode = await runGet(
      { name: 'DOES_NOT_EXIST_ANYWHERE', stdout: false },
      config,
      {
        stdout: { write: (chunk) => void stdoutChunks.push(chunk) },
        stderr: { write: (chunk) => void stderrChunks.push(chunk) },
        isTTY: false,
      },
      { createVaultAgent: (await import('@project-vault/agent')).createVaultAgent }
    )

    expect(exitCode).toBe(3)
    expect(stdoutChunks).toEqual([])
    expect(stderrChunks.join('')).toContain('was not found')
  })
})
