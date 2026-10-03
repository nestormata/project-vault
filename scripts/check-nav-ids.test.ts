// Story 68.7 AC-10: the `check-nav-ids` guard reads PV's nav registry with the TypeScript parser (no
// execution) plus the surface builders, and fails on a missing id, a broken id grammar, a collision,
// a PV id outside its surface prefix, or a parent that names a missing id. It never freezes the id
// list (PV may add, move or retire items) and has no baseline or ignore list.
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { makeRecipe, recipeRunsCommand, workflowRunCommands } from './lib/ci-wiring.js'
import { useFixtureRoots, writeFixture } from './lib/fixture-test-helpers.js'
import { checkNavIdsGuard, NAV_REGISTRY_FILE, readNavRegistrySource } from './lib/nav-guards.js'
import { run } from './check-nav-ids.js'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WEB = resolve(repositoryRoot, 'apps/web')
const makeRoot = useFixtureRoots('nav-ids-guard-', ['src/lib/navigation/surfaces'])

function registry(items: string): string {
  return `const PRIMARY = {\n  id: 'primary',\n  file: 'src/x.svelte',\n  contextKeys: [],\n  items: [\n${items}\n  ],\n}\nexport const NAV_SURFACE_DEFS = [PRIMARY]\n`
}

function tree(
  items: string,
  builder = "export const b = () => [{ id: 'primary.a', label: () => 'A' }]\n"
): string {
  const root = makeRoot()
  writeFixture(root, NAV_REGISTRY_FILE, registry(items))
  writeFixture(root, 'src/lib/navigation/surfaces/primary.ts', builder)
  return root
}

const problems = (root: string) => checkNavIdsGuard(root).problems

describe('check-nav-ids: mutation self-tests (Story 68.7 AC-10)', () => {
  it('passes a clean registry with nested children', () => {
    expect(
      problems(
        tree("    { id: 'primary.a', children: [{ id: 'primary.a.b', conditional: true }] },")
      )
    ).toEqual([])
  })

  it('fails an item without an id, in the registry or in a builder', () => {
    expect(problems(tree('    { conditional: true },'))).toEqual([
      `${NAV_REGISTRY_FILE}:6: a nav registry item has no id`,
    ])
    expect(
      problems(tree("    { id: 'primary.a' },", "export const b = () => [{ label: () => 'A' }]\n"))
    ).toEqual(['src/lib/navigation/surfaces/primary.ts:1: a nav item has a label but no id'])
  })

  it('fails a broken grammar, a wrong prefix, a collision and a missing parent', () => {
    expect(problems(tree("    { id: 'primary.Bad' },"))).toEqual([
      'nav id "primary.Bad" breaks the id grammar',
    ])
    expect(problems(tree("    { id: 'project.a' },"))).toEqual([
      'nav id "project.a" must start with its surface id "primary."',
    ])
    expect(problems(tree("    { id: 'primary.a' },\n    { id: 'primary.a' },"))).toEqual([
      'nav id "primary.a" is declared twice',
    ])
  })

  it('a registry with no surfaces fails (never a silent pass)', () => {
    const root = makeRoot()
    writeFixture(root, NAV_REGISTRY_FILE, 'export const NAV_SURFACE_DEFS = []\n')
    expect(problems(root)).toEqual([`${NAV_REGISTRY_FILE}: no nav surfaces found`])
  })

  it('reads ids as data, following the per-surface spreads (no execution)', () => {
    const surfaces = readNavRegistrySource(WEB)
    expect(surfaces.map((surface) => surface.id)).toContain('breadcrumbs')
    const breadcrumbs = surfaces.find((surface) => surface.id === 'breadcrumbs')
    expect(breadcrumbs?.ids).toContainEqual({
      id: 'breadcrumbs.platform.settings.orgs',
      parent: 'breadcrumbs.platform.settings',
      line: expect.any(Number),
    })
  })
})

describe('check-nav-ids: the real tree and its wiring', () => {
  it('reports zero problems on apps/web, over every surface', () => {
    const result = checkNavIdsGuard(WEB)
    expect(result.problems).toEqual([])
    expect(result.surfaces).toBe(16)
    expect(result.ids).toBeGreaterThan(70)
    expect(run(['--web', WEB])).toBe(0)
  })

  it('has no baseline, ignore list or skip switch in its source', () => {
    for (const file of [
      'scripts/lib/nav-guards.ts',
      'scripts/check-nav-ids.ts',
      'scripts/check-nav-surfaces.ts',
    ]) {
      expect(readFileSync(resolve(repositoryRoot, file), 'utf8')).not.toMatch(
        /allowlist|allow-list|baseline|--skip|eslint-disable|ignoreList|ignorePaths/i
      )
    }
  })

  it('is wired: package.json script, make ci-inner and the ci.yml Checks job', () => {
    const pkg = JSON.parse(readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    const recipe = makeRecipe(readFileSync(resolve(repositoryRoot, 'Makefile'), 'utf8'), 'ci-inner')
    const runs = workflowRunCommands(
      readFileSync(resolve(repositoryRoot, '.github/workflows/ci.yml'), 'utf8')
    ).join('\n')
    for (const guard of ['check-nav-ids', 'check-nav-surfaces']) {
      expect(new Map(Object.entries(pkg.scripts)).get(guard)).toBe(`tsx scripts/${guard}.ts`)
      expect(recipeRunsCommand(recipe, `pnpm ${guard}`)).toBe(true)
      expect(recipeRunsCommand(recipe, `pnpm vitest run scripts/${guard}.test.ts`)).toBe(true)
      expect(runs).toContain(`pnpm ${guard}`)
      expect(runs).toContain(`pnpm vitest run scripts/${guard}.test.ts`)
    }
  })
})
