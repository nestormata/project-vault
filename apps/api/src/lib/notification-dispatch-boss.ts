import type { BossService } from './boss.js'

/**
 * Story 70.2 AC2 — process-wide holder for the one `BossService`, read lazily by
 * `notification-originator-host.ts`.
 *
 * `buildHostServices()` runs inside `loadExtension()` during `createApp()`, long before `main.ts`
 * constructs the `BossService` (and the boss is only started on vault unseal), so the host cannot
 * capture a boss at build time. `main.ts` registers it right after `new BossService(...)`; the host
 * resolves it at enqueue time. Same single-per-process shape as `registeredGate` in
 * `capability-gate.ts`. Extension code never sees this module (extensions only receive
 * `HostServices`).
 */
let registeredBoss: BossService | undefined

/** Last registration wins; there is exactly one `BossService` per process. */
export function registerNotificationDispatchBoss(boss: BossService): void {
  registeredBoss = boss
}

/** `undefined` in any process that never registers one (unit tests, CLI tooling). */
export function getNotificationDispatchBoss(): BossService | undefined {
  return registeredBoss
}

/** Test-only reset — never called from production code. */
export function __resetNotificationDispatchBossForTests(): void {
  registeredBoss = undefined
}
