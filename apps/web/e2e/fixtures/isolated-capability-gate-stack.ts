import type { ChildProcess } from 'node:child_process'
import {
  spawnIsolatedApiProcess,
  spawnIsolatedWebProcess,
  stopProcess,
  type WebHandle,
} from './isolated-stack-shared.js'

// Journeys import createIsolatedDatabase/dropIsolatedDatabase/initIsolatedVault directly from
// `./isolated-stack-shared.js` (not re-exported here) — this file only adds the pieces that are
// specific to the capability-gate stack.

/**
 * Story 23.3 J20 — a self-contained, isolated API+web process pair for this story's own two E2E
 * journeys (Dana: no gate configured; Priya: gated via `mock-capability-gate-extension`),
 * deliberately NOT sharing the main E2E docker stack j1-j18/j6 run against — that stack already
 * dedicates its one `VAULT_EXTENSIONS_PACKAGE` slot to `@project-vault/mock-sso-extension`, and a
 * host process can only load ONE extension package at a time. Built on the same
 * `isolated-stack-shared.ts` plumbing as `isolated-envelope-stack.ts` (Story 23.2 J19); the two
 * differ only in which fixture package is loaded and which env vars that fixture needs.
 */

export type ApiHandle = {
  process: ChildProcess
  port: number
  dbName: string
  webPort: number
  extensionPackage?: string
  extraPermittedOrgId?: string
}

/**
 * Boots a real `apps/api` process against an isolated database. Pass
 * `extensionPackage: undefined` for Dana's journey (no gate configured — the byte-identical
 * no-op path, AC-5) or `'@project-vault/mock-capability-gate-extension'` for Priya's (gated).
 * `extraPermittedOrgId` is J20's "simulated upgrade" escape hatch — see the fixture's own doc
 * comment on `MOCK_CAPABILITY_GATE_EXTRA_PERMITTED_ORG_ID`.
 */
export async function startCapabilityGateApi(options: {
  port: number
  dbName: string
  webPort: number
  extensionPackage?: string
  extraPermittedOrgId?: string
}): Promise<ApiHandle> {
  const child = await spawnIsolatedApiProcess({
    port: options.port,
    dbName: options.dbName,
    webPort: options.webPort,
    logLabel: 'api-capgate',
    logLevelEnvVar: 'J20_DEBUG_LOG_LEVEL',
    extraEnv: {
      ...(options.extensionPackage ? { VAULT_EXTENSIONS_PACKAGE: options.extensionPackage } : {}),
      ...(options.extraPermittedOrgId
        ? { MOCK_CAPABILITY_GATE_EXTRA_PERMITTED_ORG_ID: options.extraPermittedOrgId }
        : {}),
    },
  })

  return {
    process: child,
    port: options.port,
    dbName: options.dbName,
    webPort: options.webPort,
    extensionPackage: options.extensionPackage,
    extraPermittedOrgId: options.extraPermittedOrgId,
  }
}

/** Restarts the API process against the SAME database, optionally with a different
 * `extraPermittedOrgId` — the only way a boot-time-read value can change, mirroring an operator's
 * deliberate restart exactly (same shape as Story 23.2 J19's `restartEnvelopeApi`). */
export async function restartCapabilityGateApi(
  handle: ApiHandle,
  overrides: { extraPermittedOrgId?: string } = {}
): Promise<ApiHandle> {
  await stopProcess(handle.process)
  return startCapabilityGateApi({
    port: handle.port,
    dbName: handle.dbName,
    webPort: handle.webPort,
    extensionPackage: handle.extensionPackage,
    extraPermittedOrgId: overrides.extraPermittedOrgId ?? handle.extraPermittedOrgId,
  })
}

export async function startCapabilityGateWeb(options: {
  port: number
  apiPort: number
}): Promise<WebHandle> {
  return spawnIsolatedWebProcess({
    port: options.port,
    apiPort: options.apiPort,
    logLabel: 'web-capgate',
  })
}
