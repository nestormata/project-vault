import type { ChildProcess } from 'node:child_process'
import { argon2Sync, randomBytes } from 'node:crypto'
import {
  spawnIsolatedApiProcess,
  spawnIsolatedWebProcess,
  stopProcess,
  type WebHandle,
} from './isolated-stack-shared.js'

// Journeys import createIsolatedDatabase/dropIsolatedDatabase/initIsolatedVault directly from
// `./isolated-stack-shared.js` (not re-exported here) — this file only adds the pieces that are
// specific to the envelope-extension stack.

/**
 * Story 23.2 — a self-contained, isolated API+web process pair for this story's own E2E journey
 * (j19), deliberately NOT sharing the main E2E docker stack j1-j18/j6 run against. That shared
 * stack already dedicates its one `VAULT_EXTENSIONS_PACKAGE` slot to `@project-vault/mock-sso-
 * extension` (see docker-compose.e2e.yml) — a host process can only load ONE extension package,
 * and switching the shared stack to this story's own fixture would silently break j6's own tests.
 *
 * More fundamentally, this story's whole point (AC-4's "resolved once at boot, applied only at
 * the next restart") cannot be exercised against a long-lived shared server that Playwright's
 * global-setup never restarts mid-suite. This harness (built on `isolated-stack-shared.ts`'s
 * common plumbing) spawns real `apps/api`/`apps/web` child processes directly (not Docker)
 * against a dedicated, freshly-created Postgres database on the SAME running Postgres server the
 * rest of E2E uses, so this journey can genuinely kill and respawn the API process between
 * assertions — the one thing that actually matters here.
 */

/**
 * Story 66.3 (F11d): a journey-only `AUTH_DUMMY_PASSWORD_HASH`. The envelope fixture declares
 * `replacesNativeLogin: true`, so the policy is never plain 'enabled', and Story 23.2 AC-6e's boot
 * check (`assertDummyPasswordHashSafe`, apps/api native-login-policy.ts) refuses to boot while the
 * value is the in-repo default. A fresh Argon2id PHC string over a random, discarded message and
 * salt satisfies it without any real secret: nothing can ever verify against it. Its m/t/p must
 * equal the isolated API's ARGON2_* settings or env validation rejects it, so `startEnvelopeApi`
 * pins ARGON2_* to these same values (code review: relying on env.ts's defaults and on nothing
 * in the runner's inherited env overriding them would re-break boot silently under NODE_ENV=test).
 * Generated once per test-runner process.
 */
const JOURNEY_ONLY_ARGON2_PARAMS = { memory: 65536, passes: 3, parallelism: 4 } as const

function journeyOnlyDummyPasswordHash(): string {
  const params = JOURNEY_ONLY_ARGON2_PARAMS
  const salt = randomBytes(16)
  const hash = argon2Sync('argon2id', {
    message: randomBytes(32),
    nonce: salt,
    tagLength: 32,
    ...params,
  })
  // PHC strings use unpadded standard base64; '=' only ever appears as trailing padding.
  const b64 = (buffer: Buffer) => buffer.toString('base64').replaceAll('=', '')
  return `$argon2id$v=19$m=${params.memory},t=${params.passes},p=${params.parallelism}$${b64(salt)}$${b64(hash)}`
}

const JOURNEY_ONLY_DUMMY_PASSWORD_HASH = journeyOnlyDummyPasswordHash()

export type ApiHandle = {
  process: ChildProcess
  port: number
  dbName: string
  envAudience: string
  webPort: number
}

/** Boots a real `apps/api` process against the isolated database, with the mock-envelope-
 * extension fixture loaded. `vaultGuardEnabled: true` is main.ts's own hardcoded default
 * (unchanged here) — POST /register, /login, /refresh are vault-guard-allowlisted (see
 * apps/api/src/plugins/vault-guard.ts), which is why this harness never needs to call
 * `/vault/init` at all: this journey only exercises those three routes plus the SSO
 * start/callback pair, and the latter two are deliberately exempted too. */
export async function startEnvelopeApi(options: {
  /** Omit to allocate a free port; a restart passes the previous port. */
  port?: number
  dbName: string
  envAudience: string
  webPort: number
}): Promise<ApiHandle> {
  const api = await spawnIsolatedApiProcess({
    port: options.port,
    dbName: options.dbName,
    webPort: options.webPort,
    logLabel: 'api-envelope',
    logLevelEnvVar: 'J19_DEBUG_LOG_LEVEL',
    extraEnv: {
      VAULT_EXTENSIONS_PACKAGE: '@project-vault/mock-envelope-extension',
      MOCK_ENVELOPE_EXPECTED_AUDIENCE: options.envAudience,
      AUTH_DUMMY_PASSWORD_HASH: JOURNEY_ONLY_DUMMY_PASSWORD_HASH,
      ARGON2_MEMORY_COST: String(JOURNEY_ONLY_ARGON2_PARAMS.memory),
      ARGON2_TIME_COST: String(JOURNEY_ONLY_ARGON2_PARAMS.passes),
      ARGON2_PARALLELISM: String(JOURNEY_ONLY_ARGON2_PARAMS.parallelism),
    },
  })
  return {
    process: api.process,
    port: api.port,
    dbName: options.dbName,
    envAudience: options.envAudience,
    webPort: options.webPort,
  }
}

/** AC-4: restarts the API process against the SAME database — the one and only way the
 * boot-resolved policy can change, mirroring an operator's deliberate restart exactly. */
export async function restartEnvelopeApi(handle: ApiHandle): Promise<ApiHandle> {
  await stopProcess(handle.process)
  return startEnvelopeApi({
    port: handle.port,
    dbName: handle.dbName,
    envAudience: handle.envAudience,
    webPort: handle.webPort,
  })
}

export async function startEnvelopeWeb(options: {
  port: number
  apiPort: number
}): Promise<WebHandle> {
  return spawnIsolatedWebProcess({
    port: options.port,
    apiPort: options.apiPort,
    logLabel: 'web-envelope',
  })
}
