// @pv-not-guard oracle of PV's own un-composed markup, valid only on PV's tree
import { cleanup, render } from '@testing-library/svelte'
import type { Component } from 'svelte'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { serializeWithoutNoise } from '$lib/test/dom.js'

// DW-610 item 7: the preference card has no route oracle for its client-rendered states, so this
// pins them (no preferences, each frequency and severity, several rows). The snapshot was recorded
// from the Story 69.12 split markup; a markup change must be a deliberate snapshot update.

vi.mock('$app/state', () => ({ page: { route: { id: null }, params: {} } }))
vi.mock('$app/forms', () => ({ enhance: () => ({ destroy: () => undefined }) }))

const FLAGS = { isAdmin: false, canSendTest: false }
const row = (alertType: string, channel: string, frequency: string, minSeverity: string) => ({
  alertType,
  channel,
  frequency,
  minSeverity,
})

let Panel: Component<Record<string, unknown>>
beforeAll(async () => {
  Panel = (await import('./NotificationPreferencesPanel.svelte')).default as unknown as typeof Panel
}, 60_000)
afterEach(cleanup)

const mountPanel = (preferences: unknown[], flagProps: Record<string, unknown> = FLAGS) =>
  render(Panel, { props: { preferences, flagProps } })

describe('NotificationPreferencesPanel client states (DW-610 item 7 pin)', () => {
  it('renders the empty, single-row and multi-row states as recorded', async () => {
    const states: Record<string, string> = {}

    states['empty'] = serializeWithoutNoise(mountPanel([]).container)
    cleanup()

    states['immediate-info'] = serializeWithoutNoise(
      mountPanel([row('credential.expiry', 'email', 'immediate', 'info')]).container
    )
    cleanup()

    states['digest-critical'] = serializeWithoutNoise(
      mountPanel([row('credential.expiry', 'slack', 'digest_daily', 'critical')]).container
    )
    cleanup()

    states['several-rows-admin'] = serializeWithoutNoise(
      mountPanel(
        [
          row('credential.expiry', 'email', 'immediate', 'info'),
          row('credential.expiry', 'slack', 'digest_daily', 'warning'),
          row('vault.unsealed', 'email', 'immediate', 'critical'),
        ],
        { isAdmin: true, canSendTest: true }
      ).container
    )

    await expect(`${JSON.stringify(states, null, 2)}\n`).toMatchFileSnapshot(
      './NotificationPreferencesPanel.states.snapshot.json'
    )
    expect(Object.keys(states)).toHaveLength(4)
  }, 60_000)
})
