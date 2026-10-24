// @pv-not-guard oracle of PV's own un-composed markup, valid only on PV's tree
import { cleanup, render, screen } from '@testing-library/svelte'
import type { Component } from 'svelte'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { BASE_EXTENSION_THEME_VARS } from '$lib/security/extension-theme-vars.js'
import { serializeIgnoringIndent } from '$lib/test/dom.js'

// Story 69.12: the legacy extension panel's states (degraded placeholder, rendered html, empty html,
// each action outcome and its status message). The panel is FROZEN legacy markup, so this pins its
// output whitespace-exactly BEFORE the mechanical split and must come out unchanged afterwards.

vi.mock('$app/state', () => ({ page: { route: { id: null }, params: {} } }))
vi.mock('$app/navigation', () => ({ goto: vi.fn(async () => undefined) }))

const ENDPOINT = '/api/v1/extensions/panels/group/actions'
const ACTION_HTML =
  '<button type="button" data-pv-action="test-action" data-pv-action-note="hi"><span>Run</span></button>'
const baseData = {
  slot: 'group',
  subpath: undefined,
  html: null as string | null,
  themeVars: BASE_EXTENSION_THEME_VARS,
  actionEndpoint: undefined as string | undefined,
}

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    clone: () => jsonResponse(status, body),
  }
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

let Panel: Component<Record<string, unknown>>
beforeAll(async () => {
  Panel = (await import('./ExtensionPanelContent.svelte')).default as unknown as typeof Panel
}, 60_000)
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const mountPanel = (overrides: Partial<typeof baseData>) =>
  render(Panel, { props: { data: { ...baseData, ...overrides } } })

async function actionState(response: unknown): Promise<string> {
  vi.stubGlobal(
    'fetch',
    response instanceof Error
      ? vi.fn().mockRejectedValue(response)
      : vi.fn().mockResolvedValue(response)
  )
  const view = mountPanel({ html: ACTION_HTML, actionEndpoint: ENDPOINT })
  screen.getByText('Run').click()
  await flush()
  const snapshot = serializeIgnoringIndent(view.container)
  cleanup()
  return snapshot
}

describe('ExtensionPanelContent states (Story 69.12 pre-split pin)', () => {
  it('renders every state exactly as before the split', async () => {
    const states: Record<string, string> = {}

    const degraded = mountPanel({ html: null })
    states['degraded'] = serializeIgnoringIndent(degraded.container)
    cleanup()

    const rendered = mountPanel({ html: '<p>hello</p>' })
    states['rendered'] = serializeIgnoringIndent(rendered.container)
    cleanup()

    const empty = mountPanel({ html: '' })
    states['empty-html'] = serializeIgnoringIndent(empty.container)
    cleanup()

    const actionable = mountPanel({ html: ACTION_HTML, actionEndpoint: ENDPOINT })
    states['actionable'] = serializeIgnoringIndent(actionable.container)
    cleanup()

    states['action-message'] = await actionState(jsonResponse(200, { message: 'Action done' }))
    states['action-html'] = await actionState(jsonResponse(200, { html: '<p>replaced</p>' }))
    states['action-validation'] = await actionState(
      jsonResponse(422, { code: 'validation_failed', message: 'Name is required' })
    )
    states['action-denied'] = await actionState(
      jsonResponse(403, { code: 'denied', message: 'secret detail' })
    )
    states['action-failure-html'] = await actionState(
      jsonResponse(409, { code: 'conflict', message: 'Stale', html: '<p>failure banner</p>' })
    )
    states['action-network-error'] = await actionState(new Error('boom'))

    await expect(`${JSON.stringify(states, null, 2)}\n`).toMatchFileSnapshot(
      './ExtensionPanelContent.states.snapshot.json'
    )
  }, 60_000)
})
