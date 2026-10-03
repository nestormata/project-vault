// Story 68.7 AC-10/AC-15: the `check-nav-surfaces` guard. In PV-originated `.svelte` files every
// `<nav>` element and every `aria-current` attribute must live in a registered nav surface renderer
// (`NAV_SURFACES[].file`): a hand-written nav anywhere else is a PV bug, fixed by registering a
// surface and rendering it from data, never by an exemption. Parsed with `svelte/compiler` (no regex
// over markup). CM-materialized files (`src/lib/_cm/**`, or files a lock records as CM's) are not
// checked (provenance, never a path list).
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { useFixtureRoots, writeFixture } from './lib/fixture-test-helpers.js'
import { checkNavSurfacesGuard, NAV_REGISTRY_FILE } from './lib/nav-guards.js'
import { run } from './check-nav-surfaces.js'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WEB = resolve(repositoryRoot, 'apps/web')
const makeRoot = useFixtureRoots('nav-surfaces-guard-', ['src/routes'])
const RENDERER = 'src/lib/navigation/Renderer.svelte'
const PAGE = 'src/routes/(app)/settings/docs/+page.svelte'

function tree(files: Record<string, string>): string {
  const root = makeRoot()
  writeFixture(
    root,
    NAV_REGISTRY_FILE,
    `export const NAV_SURFACE_DEFS = [{ id: 'primary', file: '${RENDERER}', contextKeys: [], items: [{ id: 'primary.a' }] }]\n`
  )
  for (const [rel, content] of Object.entries({ [RENDERER]: '<p>renderer</p>\n', ...files })) {
    writeFixture(root, rel, content)
  }
  return root
}

const problems = (root: string, lock?: Parameters<typeof checkNavSurfacesGuard>[1]) =>
  checkNavSurfacesGuard(root, lock).problems

describe('check-nav-surfaces: mutation self-tests (Story 68.7 AC-10)', () => {
  it('fails a hand-written <nav> on a page, naming file and line', () => {
    expect(
      problems(tree({ [PAGE]: '<h1>Docs</h1>\n<nav aria-label="Docs"><a href="/x">x</a></nav>\n' }))
    ).toEqual([
      `${PAGE}:2: <nav> outside a registered nav surface renderer; register a surface in ${NAV_REGISTRY_FILE} and render it from data`,
    ])
  })

  it('fails a multi-line <nav> tag and one inside a {#snippet}, and an aria-current', () => {
    const page =
      '<nav\n  aria-label="Docs"\n></nav>\n{#snippet s()}\n  <nav></nav>\n{/snippet}\n<a aria-current="page" href="/y">y</a>\n'
    expect(problems(tree({ [PAGE]: page }))).toEqual([
      `${PAGE}:1: <nav> outside a registered nav surface renderer; register a surface in ${NAV_REGISTRY_FILE} and render it from data`,
      `${PAGE}:5: <nav> outside a registered nav surface renderer; register a surface in ${NAV_REGISTRY_FILE} and render it from data`,
      `${PAGE}:7: aria-current outside a registered nav surface renderer; register a surface in ${NAV_REGISTRY_FILE} and render it from data`,
    ])
  })

  it('passes <nav inside an HTML comment, the same markup in a registered renderer, and CM files', () => {
    const nav = '<nav aria-label="x"><a aria-current="page" href="/">x</a></nav>\n'
    expect(
      problems(tree({ [PAGE]: '<!-- <nav> was here -->\n<p>x</p>\n', [RENDERER]: nav }))
    ).toEqual([])
    expect(
      problems(tree({ 'src/lib/_cm/CmNav.svelte': nav, 'src/lib/server/_cm/X.svelte': nav }))
    ).toEqual([])
    expect(problems(tree({ [PAGE]: nav }), { overrides: [{ path: PAGE }] })).toEqual([])
  })

  it('fails a registered renderer file that does not exist (a rename not reflected in the registry)', () => {
    const root = makeRoot()
    writeFixture(
      root,
      NAV_REGISTRY_FILE,
      "export const NAV_SURFACE_DEFS = [{ id: 'primary', file: 'src/lib/Gone.svelte', contextKeys: [], items: [] }]\n"
    )
    expect(problems(root)).toEqual([
      'surface "primary" names a renderer file that does not exist: src/lib/Gone.svelte',
    ])
  })
})

describe('check-nav-surfaces: the real tree', () => {
  it('reports zero problems on apps/web', () => {
    const result = checkNavSurfacesGuard(WEB)
    expect(result.problems).toEqual([])
    expect(result.scannedFiles).toBeGreaterThan(150)
    expect(run(['--web', WEB])).toBe(0)
  })
})
