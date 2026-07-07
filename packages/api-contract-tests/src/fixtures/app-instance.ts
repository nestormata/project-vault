import postgres from 'postgres'
import { createApp } from '@project-vault/api/app'
import { describeResponse } from './http.js'

export type TestApp = Awaited<ReturnType<typeof createApp>>

const CONTRACT_TEST_PASSPHRASE = 'contract-test-vault-passphrase-32chars'

/**
 * D4 point 1 / D6: sets the same safe env placeholders `generate-spec.ts` uses (no live
 * DATABASE_URL required for those, but this package DOES need a real migrated test database —
 * see the module doc in `contract.test.ts` for why `app.inject()` against a real Postgres is
 * this suite's interpretation of "against a running instance"). `VAULT_ALLOW_REMOTE_INIT`
 * bypasses the bootstrap-token gate for the one-time vault init call below, matching
 * `apps/api`'s own integration-test convention (`configureAuthIntegrationEnv()`).
 */
export function configureContractTestEnv(): void {
  process.env['DATABASE_URL'] ??=
    'postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault'
  process.env['CORS_ALLOWED_ORIGINS'] ??= 'http://localhost:5173'
  process.env['VAULT_ALLOW_REMOTE_INIT'] = 'true'
}

/**
 * Boots one real `createApp()` instance and initializes its vault (passphrase KMS, which
 * unseals as part of init — no separate unseal call needed) so every route that touches
 * encrypted credential values works normally. Vault state is process-local (this suite runs in
 * its own Node process via vitest), so this only needs to run once per test run.
 */
export async function bootContractTestApp(): Promise<TestApp> {
  configureContractTestEnv()
  // AC-9: without a real dbPool, GET /ready always reports 503 (reason: 'db') regardless of
  // actual database health — same wiring `main.ts` uses, so this suite exercises /ready's real
  // documented 200 happy path instead of a false "database unreachable" state.
  const sql = postgres(process.env['DATABASE_URL'] as string)
  const dbPool = { query: async (statement: string) => sql.unsafe(statement) }
  const app = await createApp({ logger: false, dbPool })
  await app.ready()

  const initRes = await app.inject({
    method: 'POST',
    url: '/api/v1/vault/init',
    payload: { kmsType: 'passphrase', passphrase: CONTRACT_TEST_PASSPHRASE },
  })

  if (initRes.statusCode === 200) return app

  // 409 ALREADY_INITIALIZED: the DB already has a vault_state row (e.g. a prior run against the
  // same database), but this process's in-memory key material is still sealed — unseal with the
  // same fixed passphrase rather than treating this as a failure.
  if (initRes.statusCode === 409) {
    const unsealRes = await app.inject({
      method: 'POST',
      url: '/api/v1/vault/unseal',
      payload: { passphrase: CONTRACT_TEST_PASSPHRASE },
    })
    if (unsealRes.statusCode === 200) return app
    throw new Error(
      `Contract test app found an already-initialized vault but could not unseal it (was it initialized with a different passphrase in a previous run?): ${describeResponse(unsealRes)}`
    )
  }

  throw new Error(`Contract test app failed to initialize its vault: ${describeResponse(initRes)}`)
}
