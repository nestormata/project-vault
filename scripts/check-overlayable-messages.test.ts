// Story 72.19 (CentralizeMe request R4): the overlayable-message guard reads the key list, PV's locale
// catalogs, every `*.test.ts` under apps/web/src and the mock UI pack's messages. It fails a test that
// writes a key's default text (raw or as a regexp literal, in any locale), a key missing from a
// catalog, and a mock pack that overlays no key of its own. It has no exempt-file list and no skip.
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { makeRecipe, recipeRunsCommand, workflowRunCommands } from './lib/ci-wiring.js'
import { useFixtureRoots, writeFixture } from './lib/fixture-test-helpers.js'
import {
  checkOverlayableMessagesGuard,
  KEYS_FILE,
  MOCK_PACK_MESSAGES_DIR,
  readOverlayableKeys,
} from './lib/overlayable-messages-guard.js'
import { run } from './check-overlayable-messages.js'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WEB = resolve(repositoryRoot, 'apps/web')
const makeRoot = useFixtureRoots('overlayable-messages-guard-', [])
const PACK_DIR = 'pack-messages'

const KEYS = "export const OVERLAYABLE_MESSAGE_KEYS = ['brand_line', 'page_title'] as const\n"

interface Tree {
  keysFile?: string
  en?: Record<string, string>
  es?: Record<string, string>
  pack?: Record<string, string>
  tests?: Record<string, string>
}

function tree(options: Tree = {}): { root: string; pack: string } {
  const root = makeRoot()
  writeFixture(root, KEYS_FILE, options.keysFile ?? KEYS)
  writeFixture(
    root,
    'messages/en.json',
    JSON.stringify(options.en ?? { brand_line: 'Run it well.', page_title: 'Sign in | Acme' })
  )
  writeFixture(
    root,
    'messages/es.json',
    JSON.stringify(options.es ?? { brand_line: 'Hazlo bien.', page_title: 'Entrar | Acme' })
  )
  writeFixture(
    root,
    `${PACK_DIR}/en.json`,
    JSON.stringify(options.pack ?? { brand_line: 'pack:line', page_title: 'pack:title' })
  )
  for (const [name, source] of Object.entries(options.tests ?? {})) {
    writeFixture(root, `src/${name}`, source)
  }
  return { root, pack: join(root, PACK_DIR) }
}

const problems = (options: Tree = {}) => {
  const { root, pack } = tree(options)
  return checkOverlayableMessagesGuard(root, pack).problems
}

describe('check-overlayable-messages: mutation self-tests (Story 72.19)', () => {
  it('passes a tree whose tests read the message and whose pack overlays every key', () => {
    expect(
      problems({
        tests: { 'a.test.ts': "expect(title).toBe(overlayableMessage('page_title', 'es'))\n" },
      })
    ).toEqual([])
  })

  it('fails a test that writes the default text of a key, in either locale', () => {
    expect(problems({ tests: { 'a.test.ts': "expect(t).toBe('Sign in | Acme')\n" } })).toEqual([
      "src/a.test.ts writes the en text of the overlayable message page_title; read it with overlayableMessage('page_title') or m.page_title() instead",
    ])
    expect(problems({ tests: { 'lib/b.test.ts': 'getByText("Hazlo bien.")\n' } })).toEqual([
      "src/lib/b.test.ts writes the es text of the overlayable message brand_line; read it with overlayableMessage('brand_line') or m.brand_line() instead",
    ])
  })

  it('fails a regular-expression literal of the default text', () => {
    expect(
      problems({ tests: { 'a.test.ts': 'getByText(/Run it well\\./i)\n' } }).join('\n')
    ).toContain('writes the en text of the overlayable message brand_line')
  })

  it('does not scan sources that are not unit tests', () => {
    expect(problems({ tests: { 'a.svelte': '<p>Run it well.</p>\n' } })).toEqual([])
  })

  it('fails a key missing from a locale catalog', () => {
    expect(problems({ es: { brand_line: 'Hazlo bien.' } })).toEqual([
      'messages/es.json has no text for the overlayable key page_title',
    ])
  })

  it('fails a pack that overlays a key with PV default text, or not at all', () => {
    expect(problems({ pack: { brand_line: 'pack:line' } })).toEqual([
      'the mock UI pack (fixtures/mock-ui-pack/ui-pack/messages) does not overlay page_title with text of its own, so the composed run cannot prove it overlayable',
    ])
    expect(
      problems({ pack: { brand_line: 'pack:line', page_title: 'Sign in | Acme' } })
    ).toHaveLength(1)
  })

  it('fails a missing or empty key list instead of passing vacuously', () => {
    expect(problems({ keysFile: 'export const OTHER = []\n' })).toEqual([
      `${KEYS_FILE}: no OVERLAYABLE_MESSAGE_KEYS array literal with at least one key`,
    ])
    expect(
      problems({ keysFile: 'export const OVERLAYABLE_MESSAGE_KEYS = [] as const\n' })
    ).toHaveLength(1)
  })
})

describe('check-overlayable-messages: the real tree and its wiring', () => {
  it('lists the keys the story names and reports zero problems', () => {
    expect(readOverlayableKeys(WEB)).toEqual([
      'auth_login_page_description',
      'auth_login_page_title',
      'auth_register_page_title',
      'shell_brand_tagline',
    ])
    const result = checkOverlayableMessagesGuard(WEB)
    expect(result.problems).toEqual([])
    expect(result.locales).toBe(2)
    expect(result.tests).toBeGreaterThan(300)
    expect(run(['--web', WEB])).toBe(0)
  })

  it('reads the mock pack from the repository fixture directory', () => {
    expect(MOCK_PACK_MESSAGES_DIR).toBe('fixtures/mock-ui-pack/ui-pack/messages')
  })

  it('has no baseline, ignore list or skip switch in its source', () => {
    for (const file of [
      'scripts/lib/overlayable-messages-guard.ts',
      'scripts/check-overlayable-messages.ts',
    ]) {
      expect(readFileSync(resolve(repositoryRoot, file), 'utf8')).not.toMatch(
        /allowlist|allow-list|baseline|--skip|eslint-disable|ignoreList|ignorePaths/i
      )
    }
  })

  it('is wired: package.json script, make ci-inner and the ci.yml Checks job', () => {
    const guard = 'check-overlayable-messages'
    const pkg = JSON.parse(readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    const recipe = makeRecipe(readFileSync(resolve(repositoryRoot, 'Makefile'), 'utf8'), 'ci-inner')
    const runs = workflowRunCommands(
      readFileSync(resolve(repositoryRoot, '.github/workflows/ci.yml'), 'utf8')
    ).join('\n')
    expect(new Map(Object.entries(pkg.scripts)).get(guard)).toBe(`tsx scripts/${guard}.ts`)
    expect(recipeRunsCommand(recipe, `pnpm ${guard}`)).toBe(true)
    expect(recipeRunsCommand(recipe, `pnpm vitest run scripts/${guard}.test.ts`)).toBe(true)
    expect(runs).toContain(`pnpm ${guard}`)
    expect(runs).toContain(`pnpm vitest run scripts/${guard}.test.ts`)
  })
})
