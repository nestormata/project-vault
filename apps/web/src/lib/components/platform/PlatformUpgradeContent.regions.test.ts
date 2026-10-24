import { cleanup, render, screen } from '@testing-library/svelte'
import type { Component } from 'svelte'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

// Story 69.12: the platform upgrade page is four cards (version, CLI policy, procedure, API docs),
// each a sub-region. A probe contribution lands after its own card's content, and a caller who is
// not a platform operator gets no sub-region.

vi.mock('$app/state', () => ({
  page: { route: { id: '/(app)/platform/upgrade' }, params: {} },
}))

const POINTS = [
  'platform.upgrade.version',
  'platform.upgrade.cli-policy',
  'platform.upgrade.procedure',
  'platform.upgrade.api-docs',
] as const
const fills = Object.fromEntries(POINTS.map((point) => [point, [{ marker: `fill:${point}` }]]))
const POLICY = {
  status: 'ok',
  policy: {
    server: { version: '1.3.0', versionSource: 'release' },
    cli: { current: '1.3.0', minimumSupported: '1.1.0', withdrawn: [] },
  },
}

let Content: Component<Record<string, unknown>>
beforeAll(async () => {
  const probe = (await import('$lib/test/injection/Probe.svelte')).default
  for (const point of POINTS) {
    vi.doMock(`virtual:pv-inject/${point}`, () => ({
      default: [{ id: `${point}#0`, order: 0, component: probe }],
    }))
  }
  Content = (await import('./PlatformUpgradeContent.svelte')).default as unknown as typeof Content
}, 60_000)
afterEach(cleanup)

const mount = (pageData: Record<string, unknown> = {}) =>
  render(Content, {
    props: {
      pageData: {
        allowed: true,
        version: '0.9.0',
        versionSource: 'release',
        apiDocsEnabled: true,
        cliPolicy: POLICY,
        ...pageData,
      },
      data: fills,
    },
  })
const probe = (point: string): HTMLElement => {
  const found = screen
    .getAllByTestId('probe')
    .find((el) => el.textContent?.includes(`"fill:${point}"`))
  if (found === undefined) throw new Error(`no probe for ${point}`)
  return found
}
const heading = (name: string) => screen.getByRole('heading', { name })
const follows = (a: Node, b: Node): boolean =>
  (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0

describe('PlatformUpgradeContent sub-regions (probe order)', () => {
  it('each point follows its own card content and precedes the next card', () => {
    mount()
    const version = probe('platform.upgrade.version')
    const cli = probe('platform.upgrade.cli-policy')
    const procedure = probe('platform.upgrade.procedure')
    const docs = probe('platform.upgrade.api-docs')
    expect(follows(screen.getByText('This is a release build.'), version)).toBe(true)
    expect(follows(version, heading('CLI Version Policy'))).toBe(true)
    expect(follows(heading('CLI Version Policy'), cli)).toBe(true)
    expect(follows(cli, heading('Upgrade Procedure'))).toBe(true)
    expect(follows(screen.getByText(/Upgrade procedure \(docs\/runbook\.md/), procedure)).toBe(true)
    expect(follows(procedure, heading('API Documentation'))).toBe(true)
    expect(follows(screen.getByText(/Open API Documentation/), docs)).toBe(true)
  })

  it('the version, procedure and docs points are the last child of their card', () => {
    mount()
    const version = probe('platform.upgrade.version')
    expect(version.parentElement?.tagName).toBe('SECTION')
    expect(version.parentElement?.lastElementChild).toBe(version)
    const procedure = probe('platform.upgrade.procedure')
    expect(procedure.previousElementSibling?.tagName).toBe('SECTION')
    expect(procedure.previousElementSibling).toBe(heading('Upgrade Procedure').parentElement)
    const docs = probe('platform.upgrade.api-docs')
    expect(docs.parentElement?.lastElementChild).toBe(docs)
    expect(docs.previousElementSibling?.tagName).toBe('A')
  })

  it('the CLI policy point sits right after the policy card', () => {
    mount()
    const cli = probe('platform.upgrade.cli-policy')
    expect(cli.previousElementSibling).toBe(heading('CLI Version Policy').parentElement)
  })

  it('a point still renders when the card shows its fallback copy', () => {
    mount({ version: null, versionSource: null, apiDocsEnabled: false })
    expect(follows(screen.getByText('Version information unavailable.'), probe(POINTS[0]))).toBe(
      true
    )
    expect(
      follows(screen.getByText(/API documentation browsing is not enabled/), probe(POINTS[3]))
    ).toBe(true)
  })

  it('points receive the standard point props and never the page data', () => {
    mount()
    for (const point of POINTS) {
      const keys = (probe(point).getAttribute('data-keys') ?? '').split(',')
      expect(keys).toEqual(['data', 'params', 'routeId'])
    }
  })

  it('a caller who is not a platform operator sees no sub-region', () => {
    mount({ allowed: false })
    expect(screen.queryAllByTestId('probe')).toHaveLength(0)
    expect(screen.getByRole('heading', { name: /platform operator access required/i })).toBeTruthy()
  })
})
