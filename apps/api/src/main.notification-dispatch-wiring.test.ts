import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Story 70.2 AC11 — production wiring guard. The originator host resolves the process's
// BossService through a registry that only `main.ts` can fill. If that line is deleted every unit
// test stays green while production silently reverts to the 5-15 minute catch-up latency, so this
// source-level guard pins it.

// A literal path (vitest runs with cwd = apps/api), so the scan needs no dynamic filename.
const mainSource = readFileSync('src/main.ts', 'utf-8')

describe('main.ts notification-dispatch boss wiring (Story 70.2 AC11)', () => {
  it('registers the process BossService with the notification dispatch registry', () => {
    expect(mainSource).toMatch(/registerNotificationDispatchBoss\(boss\)/)
  })

  it('registers it right after the BossService is constructed, before any worker setup', () => {
    const constructed = mainSource.indexOf('new BossService(')
    const registered = mainSource.indexOf('registerNotificationDispatchBoss(boss)')
    const started = mainSource.indexOf('async function startBossAndRegisterWorkers')
    expect(constructed).toBeGreaterThan(-1)
    expect(registered).toBeGreaterThan(constructed)
    expect(registered).toBeLessThan(started)
  })

  it('imports the registry from the lib module', () => {
    expect(mainSource).toMatch(
      /import\s*\{[^}]*registerNotificationDispatchBoss[^}]*\}\s*from\s*'\.\/lib\/notification-dispatch-boss\.js'/
    )
  })
})
