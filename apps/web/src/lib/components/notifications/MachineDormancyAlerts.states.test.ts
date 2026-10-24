// @pv-not-guard oracle of PV's own un-composed markup, valid only on PV's tree
import { cleanup, render } from '@testing-library/svelte'
import type { Component } from 'svelte'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { serializeIgnoringIndent } from '$lib/test/dom.js'

// Story 69.12: the machine key dormancy cards (no alerts, an alert that never used its key, alerts
// with a last-used date). Recorded BEFORE the split into sub-regions; it must come out unchanged.

process.env.TZ = 'America/Panama'

vi.mock('$app/state', () => ({ page: { route: { id: null }, params: {} } }))
vi.mock('$app/forms', () => ({ enhance: () => ({ destroy: () => undefined }) }))

const ALERTS = [
  {
    id: 'a-1',
    machineUserId: 'mu-1',
    machineUserName: 'Deploy bot',
    keyId: 'k-1',
    keyName: 'CI key',
    lastUsedAt: null,
    projectId: 'p-1',
    createdAt: '2026-09-01T08:00:00.000Z',
  },
  {
    id: 'a-2',
    machineUserId: 'mu-2',
    machineUserName: 'Backup job',
    keyId: 'k-2',
    keyName: 'Nightly',
    lastUsedAt: '2026-08-15T12:00:00.000Z',
    projectId: 'p-2',
    createdAt: '2026-09-02T08:00:00.000Z',
  },
]

const CASES: Record<string, unknown[]> = {
  empty: [],
  'one-never-used': [ALERTS[0]],
  'two-alerts': ALERTS,
}

let Alerts: Component<Record<string, unknown>>
beforeAll(async () => {
  Alerts = (await import('./MachineDormancyAlerts.svelte')).default as unknown as typeof Alerts
}, 60_000)
afterEach(cleanup)

const mountAlerts = (dormancyAlerts: unknown[]) => render(Alerts, { props: { dormancyAlerts } })

describe('MachineDormancyAlerts states (Story 69.12 pre-split pin)', () => {
  it('renders every state exactly as before the split', async () => {
    const states: [string, string][] = []
    for (const [name, dormancyAlerts] of Object.entries(CASES)) {
      const view = mountAlerts(dormancyAlerts)
      states.push([name, serializeIgnoringIndent(view.container)])
      cleanup()
    }
    await expect(`${JSON.stringify(Object.fromEntries(states), null, 2)}\n`).toMatchFileSnapshot(
      './MachineDormancyAlerts.states.snapshot.json'
    )
  }, 60_000)
})
