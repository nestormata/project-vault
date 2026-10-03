// Story 68.7 AC-16 (design §12, guardrail 1): a SHIPPED test that validates the whole nav delta of
// the tree it runs in. It imports the real `virtual:pv-nav` module: in PV's own tree the delta is
// empty (passes trivially); in a composed tree (story 68-9 runs PV's shipped tests over CM's tree)
// it is CM's `nav.ts`, and any integrity problem, a callback that throws, or an empty label under
// any locale fails CM's CI, also for ids passed as variables (Q8), which compose time cannot see.
import delta from 'virtual:pv-nav'
import { afterAll, describe, expect, it } from 'vitest'
import { setLocale } from '$lib/paraglide/runtime.js'
import { renderSurface } from './build-surface.js'
import { NAV_IDS } from './nav-registry.js'
import { cmDelta } from './fixtures/cm-delta.js'
import type { NavContexts, NavDelta, NavNode, NavSurfaceId } from './types.js'
import { validateNavDelta } from './validate-delta.js'

const ROLES = ['owner', 'admin', 'member', 'viewer']
const BOOLS = [false, true]

const users = ROLES.flatMap((orgRole) =>
  BOOLS.map((isPlatformOperator) => ({ orgRole, isPlatformOperator }))
)
const breadcrumbNodes = NAV_IDS.filter((entry) => entry.surface === 'breadcrumbs').map((e) => e.id)

/** The full context matrix of every surface. */
function contexts(): { [S in NavSurfaceId]: NavContexts[S][] } {
  const pathname = '/'
  return {
    primary: users.flatMap((user) =>
      BOOLS.map((hasUiPanelExtension) => ({ pathname, user, hasUiPanelExtension }))
    ),
    project: ROLES.map((orgRole) => ({ pathname, projectId: 'p1', orgRole })),
    'shell.brand': BOOLS.map((hidePrimaryNav) => ({ pathname, hidePrimaryNav })),
    'shell.utility': [0, 5, 150].map((unreadCount) => ({ pathname, unreadCount })),
    'shell.mfa-banner': [{ pathname, bannerMessage: 'Enroll at /settings/security.' }],
    account: users.map((user) => ({ pathname, user })),
    footer: [{ pathname }],
    'settings.index': [{ pathname }],
    'platform.index': [{ pathname }],
    'platform.settings.links': [{ pathname }],
    'settings.audit.links': [{ pathname }],
    'notifications.tabs': ['all', 'unread', 'read'].map((status) => ({ pathname, status })),
    breadcrumbs: [...breadcrumbNodes, 'cm.reports'].map((node) => ({ pathname, node })),
    back: [{ pathname, projectId: 'p1', credentialId: 'c1' }],
    'error.nav': BOOLS.map((authenticated) => ({ pathname, authenticated })),
    'auth.links': [{ pathname }],
  }
}

function labels(nodes: readonly NavNode[]): string[] {
  return nodes.flatMap((node) => [node.label, ...labels(node.children)])
}

/** Renders every surface over its matrix in strict mode (any problem or throwing callback throws)
 * and returns every rendered label. */
function exercise(source: NavDelta): string[] {
  const out: string[] = []
  for (const [surface, matrix] of Object.entries(contexts())) {
    for (const ctx of matrix) {
      const nodes = renderSurface(surface as NavSurfaceId, ctx as never, {
        delta: source,
        strict: true,
      })
      out.push(...labels(nodes))
    }
  }
  return out
}

async function inEveryLocale(source: NavDelta): Promise<void> {
  expect(validateNavDelta(source).problems).toEqual([])
  for (const locale of ['en', 'es'] as const) {
    await setLocale(locale, { reload: false })
    const rendered = exercise(source)
    expect(rendered.length).toBeGreaterThan(50)
    expect(
      rendered.filter((label) => label.trim() === ''),
      `empty labels under ${locale}`
    ).toEqual([])
  }
}

afterAll(async () => {
  await setLocale('en', { reload: false })
})

describe('the composed nav delta is valid on every surface (Story 68.7 AC-16)', () => {
  it("this tree's delta (virtual:pv-nav) validates, renders and labels every item in en and es", async () => {
    await inEveryLocale(delta)
  })

  it('a CentralizeMe-shaped delta using every operation does too', async () => {
    await inEveryLocale(cmDelta)
  })

  it('catches what compose time cannot: an operative op on a vanished id passed as a variable', () => {
    const vanished = ['primary', 'gone'].join('.')
    const broken: NavDelta = { primary: [{ op: 'move', id: vanished, parent: 'primary' }] }
    expect(validateNavDelta(broken).problems).toEqual([
      'primary: op 1 (move) unknown nav id "primary.gone"',
    ])
    expect(() => exercise(broken)).toThrow('unknown nav id "primary.gone"')
  })

  it('catches a label function that throws', () => {
    const throwing: NavDelta = {
      footer: [
        {
          op: 'relabel',
          id: 'footer.github',
          label: () => {
            throw new Error('no translation')
          },
        },
      ],
    }
    expect(() => exercise(throwing)).toThrow('nav item "footer.github": no translation')
  })
})
