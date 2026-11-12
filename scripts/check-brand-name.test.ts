// Story 72.16 AC-2 / 72.25: the `check-brand-name` guard fails on a hard-coded product name in
// markup, in a script literal, in a .ts file, in app.html, in a message catalogue, and in static
// web manifests and SVG text. It passes comments, test files, PNGs, the `brand_name` message and
// `{brand}`-parameter messages. It has no exemption list.
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { makeRecipe, recipeRunsCommand, workflowRunCommands } from './lib/ci-wiring.js'
import { useFixtureRoots, writeFixture } from './lib/fixture-test-helpers.js'
import { BRAND_LITERAL, checkBrandNameGuard } from './lib/brand-name-guard.js'
import { run } from './check-brand-name.js'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WEB = resolve(repositoryRoot, 'apps/web')
const makeRoot = useFixtureRoots('brand-name-guard-', ['src', 'messages'])
const CLEAN_CATALOGUE = JSON.stringify({ brand_name: BRAND_LITERAL, page: 'Sign in | {brand}' })

function tree(files: Record<string, string>): string {
  const root = makeRoot()
  writeFixture(root, 'messages/en.json', CLEAN_CATALOGUE)
  writeFixture(root, 'src/app.html', '<title>%brand.name%</title>')
  for (const [path, content] of Object.entries(files)) writeFixture(root, path, content)
  return root
}

const problems = (files: Record<string, string>) => checkBrandNameGuard(tree(files)).problems

describe('check-brand-name: mutation self-tests (Story 72.16 AC-2)', () => {
  it('passes a clean tree, comments and test files', () => {
    expect(
      problems({
        'src/a.svelte': `<!-- ${BRAND_LITERAL} -->\n<script lang="ts">\n  // ${BRAND_LITERAL}\n  const x = 1\n</script>\n<p>{x}</p>`,
        'src/b.ts': `/** ${BRAND_LITERAL} */\n// ${BRAND_LITERAL}\nexport const b = 1\n`,
        'src/b.test.ts': `export const t = '${BRAND_LITERAL}'\n`,
      })
    ).toEqual([])
  })

  it('fails markup text, an attribute value and a title', () => {
    expect(problems({ 'src/a.svelte': `<h1>${BRAND_LITERAL}</h1>\n` })).toEqual([
      `src/a.svelte:1: hard-codes "${BRAND_LITERAL}"; read m.brand_name()`,
    ])
    expect(
      problems({ 'src/a.svelte': `<img alt="${BRAND_LITERAL} logo" src="x" />\n` })
    ).toHaveLength(1)
    expect(
      problems({
        'src/a.svelte': `<svelte:head>\n  <title>Foo | ${BRAND_LITERAL}</title>\n</svelte:head>\n`,
      })
    ).toEqual([`src/a.svelte:2: hard-codes "${BRAND_LITERAL}"; read m.brand_name()`])
  })

  it('fails a script literal, a template literal and a .ts string', () => {
    expect(
      problems({ 'src/a.svelte': `<script>\n  const t = 'Back to ${BRAND_LITERAL}'\n</script>\n` })
    ).toHaveLength(1)
    expect(problems({ 'src/b.ts': `export const t = \`Hello \${1} ${BRAND_LITERAL}\`\n` })).toEqual(
      [`src/b.ts:1: hard-codes "${BRAND_LITERAL}"; read m.brand_name()`]
    )
    expect(problems({ 'src/b.ts': `export const t = '${BRAND_LITERAL}'\n` })).toHaveLength(1)
  })

  it('fails app.html, a hard-coded catalogue message and a missing brand_name', () => {
    expect(problems({ 'src/app.html': `<title>${BRAND_LITERAL}</title>` })).toHaveLength(1)
    const root = tree({})
    writeFixture(
      root,
      'messages/es.json',
      JSON.stringify({ brand_name: 'X', t: `Hola ${BRAND_LITERAL}` })
    )
    expect(checkBrandNameGuard(root).problems).toEqual([
      `messages/es.json: message "t" hard-codes "${BRAND_LITERAL}"; take it as the {brand} parameter`,
    ])
    const none = makeRoot()
    writeFixture(none, 'src/a.ts', 'export const a = 1\n')
    writeFixture(none, 'messages/en.json', '{"t":"x"}')
    expect(checkBrandNameGuard(none).problems).toEqual([
      'messages/en.json: the "brand_name" message is missing',
    ])
  })

  it('catches case, line-break and non-breaking-space variants of the name', () => {
    expect(problems({ 'src/a.svelte': '<p>project vault</p>\n' })).toHaveLength(1)
    expect(problems({ 'src/a.svelte': '<p>Project\n  Vault</p>\n' })).toHaveLength(1)
    expect(problems({ 'src/b.ts': "export const t = 'Project\u00a0Vault'\n" })).toHaveLength(1)
    expect(problems({ 'src/c.js': "export const t = 'Project Vault'\n" })).toHaveLength(1)
  })

  it('an empty scan never passes', () => {
    const root = makeRoot()
    expect(checkBrandNameGuard(root).problems).toEqual([
      'src: no source files found (an empty scan never passes)',
      'messages: no message catalogues found',
    ])
  })

  it('fails a web manifest and SVG text that hard-code the product name', () => {
    expect(
      problems({
        'static/manifest.webmanifest': JSON.stringify({ name: BRAND_LITERAL, icons: [] }),
      })
    ).toEqual([
      `static/manifest.webmanifest:1: hard-codes "${BRAND_LITERAL}"; overlay the static file or drop the literal`,
    ])
    expect(
      problems({
        'static/logo.svg': `<svg xmlns="http://www.w3.org/2000/svg"><text>${BRAND_LITERAL}</text></svg>\n`,
      })
    ).toEqual([
      `static/logo.svg:1: hard-codes "${BRAND_LITERAL}"; overlay the static file or drop the literal`,
    ])
    expect(problems({ 'static/logo.svg': '<svg><text>project vault</text></svg>\n' })).toHaveLength(
      1
    )
    expect(
      problems({
        'static/manifest.json': JSON.stringify({
          short_name: 'PV',
          icons: [{ purpose: `any ${BRAND_LITERAL}` }],
        }),
      })
    ).toHaveLength(1)
    expect(problems({ 'static/manifest.json': '{"name":"Project\\u0020Vault"}' })).toEqual([
      `static/manifest.json: hard-codes "${BRAND_LITERAL}"; overlay the static file or drop the literal`,
    ])
  })

  it('passes SVG comments, PNGs that contain the name as bytes, and an empty static dir', () => {
    expect(
      problems({
        'static/mark.svg': `<!-- ${BRAND_LITERAL} -->\n<svg xmlns="http://www.w3.org/2000/svg"><text>Vault</text></svg>\n`,
        'static/logo.png': `PNG ${BRAND_LITERAL} binary\n`,
        'static/manifest.webmanifest': JSON.stringify({ name: 'Vault' }),
      })
    ).toEqual([])
    const root = tree({})
    expect(checkBrandNameGuard(root).problems).toEqual([])
    expect(checkBrandNameGuard(root).staticFiles).toBe(0)
  })

  it('fails SVG and HTML that hide the product name behind HTML entities', () => {
    expect(
      problems({
        'static/logo.svg':
          '<svg xmlns="http://www.w3.org/2000/svg"><text>Project&nbsp;Vault</text></svg>\n',
      })
    ).toEqual([
      `static/logo.svg:1: hard-codes "${BRAND_LITERAL}"; overlay the static file or drop the literal`,
    ])
    expect(problems({ 'src/app.html': '<title>Project&nbsp;Vault</title>' })).toEqual([
      `src/app.html:1: hard-codes "${BRAND_LITERAL}"; read m.brand_name()`,
    ])
    expect(
      problems({ 'static/logo.svg': '<svg><text>Project&#160;Vault</text></svg>\n' })
    ).toHaveLength(1)
    expect(
      problems({ 'static/logo.svg': '<svg><text>Project&#xA0;Vault</text></svg>\n' })
    ).toHaveLength(1)
    expect(
      problems({ 'static/logo.svg': '<svg><text>Projec&#116; Vault</text></svg>\n' })
    ).toHaveLength(1)
    expect(
      problems({
        'static/logo.svg': '<svg><text>Project&amp;nbsp;Vault</text></svg>\n',
      })
    ).toEqual([])
    expect(
      problems({
        'static/mark.svg': '<!-- Project&nbsp;Vault -->\n<svg><text>Vault</text></svg>\n',
      })
    ).toEqual([])
    expect(problems({ 'src/a.svelte': '<p>Project&nbsp;Vault</p>\n' })).toHaveLength(1)
  })

  it('reports invalid JSON in a scanned manifest and still ignores a missing static dir', () => {
    expect(problems({ 'static/manifest.json': '{ not json' })).toEqual([
      'static/manifest.json: not valid JSON',
    ])
    expect(
      problems({ 'static/icons/mark.svg': `<svg aria-label="${BRAND_LITERAL}"></svg>\n` })
    ).toEqual([
      `static/icons/mark.svg:1: hard-codes "${BRAND_LITERAL}"; overlay the static file or drop the literal`,
    ])
  })
})

describe('check-brand-name: the real tree and its wiring', () => {
  it('reports zero problems on apps/web', () => {
    const result = checkBrandNameGuard(WEB)
    expect(result.problems).toEqual([])
    expect(result.files).toBeGreaterThan(300)
    expect(result.staticFiles).toBe(0)
    expect(result.messageFiles).toBe(2)
    expect(run(['--web', WEB])).toBe(0)
  })

  it('has no baseline, exemption list or skip switch in its source', () => {
    for (const file of ['scripts/lib/brand-name-guard.ts', 'scripts/check-brand-name.ts']) {
      expect(readFileSync(resolve(repositoryRoot, file), 'utf8')).not.toMatch(
        /allowlist|allow-list|baseline|--skip|eslint-disable|ignoreList|ignorePaths|exempt/i
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
    expect(new Map(Object.entries(pkg.scripts)).get('check-brand-name')).toBe(
      'tsx scripts/check-brand-name.ts'
    )
    expect(recipeRunsCommand(recipe, 'pnpm check-brand-name')).toBe(true)
    expect(recipeRunsCommand(recipe, 'pnpm vitest run scripts/check-brand-name.test.ts')).toBe(true)
    expect(runs).toContain('pnpm check-brand-name')
    expect(runs).toContain('pnpm vitest run scripts/check-brand-name.test.ts')
  })
})
