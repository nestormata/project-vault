// @pv-not-guard oracle of PV's own un-composed markup, valid only on PV's tree
import { cleanup, render } from '@testing-library/svelte'
import type { Component } from 'svelte'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { serializeIgnoringIndent } from '$lib/test/dom.js'

// Story 69.12: the "Shareable link" card in each state (the link, copied, a legacy link that cannot
// be redisplayed, a link that is briefly unavailable, busy). Recorded BEFORE the split into
// sub-regions; it must come out unchanged.

vi.mock('$app/state', () => ({ page: { route: { id: null }, params: {} } }))

const BASE = {
  publicUrl: 'https://vault.example.test/status/tok-1',
  legacyToken: false,
  copied: false,
  isBusy: false,
}
const CASES: Record<string, Record<string, unknown>> = {
  link: BASE,
  'link-copied': { ...BASE, copied: true },
  'link-busy': { ...BASE, isBusy: true },
  legacy: { ...BASE, publicUrl: null, legacyToken: true },
  'legacy-busy': { ...BASE, publicUrl: null, legacyToken: true, isBusy: true },
  unavailable: { ...BASE, publicUrl: null },
}

let Link: Component<Record<string, unknown>>
beforeAll(async () => {
  Link = (await import('./StatusPageLink.svelte')).default as unknown as typeof Link
}, 60_000)
afterEach(cleanup)

const mountLink = (state: Record<string, unknown>) =>
  render(Link, {
    props: {
      project: { id: 'p-1', name: 'Project' },
      onRegenerate: vi.fn(),
      onDisable: vi.fn(),
      onCopy: vi.fn(),
      ...state,
    },
  })

describe('StatusPageLink states (Story 69.12 pre-split pin)', () => {
  it('renders every state exactly as before the split', async () => {
    const states: [string, string][] = []
    for (const [name, state] of Object.entries(CASES)) {
      const view = mountLink(state)
      states.push([name, serializeIgnoringIndent(view.container)])
      cleanup()
    }
    await expect(`${JSON.stringify(Object.fromEntries(states), null, 2)}\n`).toMatchFileSnapshot(
      './StatusPageLink.states.snapshot.json'
    )
  }, 60_000)
})
