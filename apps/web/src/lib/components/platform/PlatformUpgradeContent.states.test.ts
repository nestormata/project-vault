// @pv-not-guard oracle of PV's own un-composed markup, valid only on PV's tree
import { cleanup, render } from '@testing-library/svelte'
import type { Component } from 'svelte'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { CliVersionPolicyResult } from '$lib/api/platform.js'
import { serializeIgnoringIndent } from '$lib/test/dom.js'

// Story 69.12: the platform upgrade page's states (denied caller, each version source, no version,
// API docs on and off, a few CLI policy outcomes). This pins them: the snapshot was recorded BEFORE
// the component was split into sub-regions and must come out unchanged afterwards. The mount helper
// below is the only line that follows the component's props.

vi.mock('$app/state', () => ({ page: { route: { id: null }, params: {} } }))

const policyOk: CliVersionPolicyResult = {
  status: 'ok',
  policy: {
    server: { version: '1.3.0', versionSource: 'release' },
    cli: {
      current: '1.3.0',
      minimumSupported: '1.1.0',
      withdrawn: [{ version: '1.2.1', reason: "Withdrawn by this server's administrator." }],
    },
  },
}
const policyUnavailable: CliVersionPolicyResult = { status: 'unavailable', reason: 'timeout' }

const allowed = {
  allowed: true,
  version: '0.9.0',
  versionSource: 'release',
  apiDocsEnabled: true,
  cliPolicy: policyOk,
}

const CASES: Record<string, Record<string, unknown>> = {
  denied: { allowed: false },
  'release-docs-on': allowed,
  'development-docs-off': {
    ...allowed,
    version: 'dev',
    versionSource: 'development',
    apiDocsEnabled: false,
  },
  'unknown-source': { ...allowed, versionSource: null },
  'no-version': { ...allowed, version: null, versionSource: null },
  'policy-unavailable': { ...allowed, cliPolicy: policyUnavailable },
}

let Content: Component<Record<string, unknown>>
beforeAll(async () => {
  Content = (await import('./PlatformUpgradeContent.svelte')).default as unknown as typeof Content
}, 60_000)
afterEach(cleanup)

const mountContent = (pageData: Record<string, unknown>) => render(Content, { props: { pageData } })

describe('PlatformUpgradeContent states (Story 69.12 pre-split pin)', () => {
  it('renders every state exactly as before the split', async () => {
    const states: [string, string][] = []
    for (const [name, pageData] of Object.entries(CASES)) {
      const view = mountContent(pageData)
      states.push([name, serializeIgnoringIndent(view.container)])
      cleanup()
    }
    await expect(`${JSON.stringify(Object.fromEntries(states), null, 2)}\n`).toMatchFileSnapshot(
      './PlatformUpgradeContent.states.snapshot.json'
    )
  }, 60_000)
})
