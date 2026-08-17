import type { ChildProcess } from 'node:child_process'
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
  port: number
  dbName: string
  envAudience: string
  webPort: number
}): Promise<ApiHandle> {
  const child = await spawnIsolatedApiProcess({
    port: options.port,
    dbName: options.dbName,
    webPort: options.webPort,
    logLabel: 'api-envelope',
    logLevelEnvVar: 'J19_DEBUG_LOG_LEVEL',
    extraEnv: {
      VAULT_EXTENSIONS_PACKAGE: '@project-vault/mock-envelope-extension',
      MOCK_ENVELOPE_EXPECTED_AUDIENCE: options.envAudience,
    },
  })
  return {
    process: child,
    port: options.port,
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
