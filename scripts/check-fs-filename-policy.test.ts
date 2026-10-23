import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ESLint } from 'eslint'
import { afterEach, describe, expect, it } from 'vitest'
import { FS_ACCESS_MODULES } from '../packages/eslint-config/index.js'
import { writeFixture } from './lib/fixture-test-helpers.js'
import { makeRecipe, recipeRunsCommand, workflowRunCommands } from './lib/ci-wiring.js'
import { resolveTrustedExecutable } from './lib/trusted-executable.js'
import { findFsFilenamePolicyViolations } from './check-fs-filename-policy.js'
import makefile from '../Makefile?raw'
import ciWorkflow from '../.github/workflows/ci.yml?raw'
import packageJson from '../package.json?raw'

// Built by concatenation so this test file never contains the rule name inside a directive.
const RULE = 'security/detect-non-literal-' + 'fs-filename'
const SHIPPED = 'apps/web/guards/fs-access.ts'
const KIT = 'packages/composition-kit/src/fs-access.ts'
const GOOD_MODULE = [
  "import { readFileSync } from 'node:fs'",
  '',
  '/**',
  ' * Reads a caller-supplied file.',
  ' * Reason: the root is the composition root chosen by the operator, never request input.',
  ' */',
  'export function readText(path: string): string {',
  "  return readFileSync(path, 'utf8')",
  '}',
  '',
].join('\n')

const git = resolveTrustedExecutable('git')
const tempRoots: string[] = []
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A throwaway git repo whose tracked files are exactly `files` (path -> content). */
function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'fs-filename-policy-'))
  tempRoots.push(root)
  execFileSync(git, ['init', '--initial-branch=main'], { cwd: root, stdio: 'ignore' })
  writeFixture(root, 'README.md', 'clean\n')
  for (const [path, content] of Object.entries(files)) writeFixture(root, path, content)
  execFileSync(git, ['add', '-A'], { cwd: root, stdio: 'ignore' })
  return root
}

const pins = [SHIPPED, KIT]
const cleanFiles = { [SHIPPED]: GOOD_MODULE, [KIT]: GOOD_MODULE }

describe('findFsFilenamePolicyViolations (AC-7)', () => {
  it('a clean tree with pinned, reasoned modules passes', () => {
    expect(findFsFilenamePolicyViolations(repo(cleanFiles), pins)).toEqual([])
  })

  it.each([
    ['line directive', `// eslint-disable-next-line ${RULE} -- reason\nreadFileSync(p)\n`],
    ['file-level block directive', `/* eslint-disable ${RULE} */\nreadFileSync(p)\n`],
    ['same-line directive', `readFileSync(p) // eslint-disable-line ${RULE}\n`],
    ['rule name wrapped onto the next line', `/* eslint-disable\n  ${RULE} */\n`],
    ['inline rule-config comment', `/* eslint ${RULE}: off */\nreadFileSync(p)\n`],
    ['bare next-line disable (every rule)', '// eslint-disable-next-line\nreadFileSync(p)\n'],
    ['bare block disable (every rule)', '/* eslint-disable */\nreadFileSync(p)\n'],
    ['bare disable with only a reason', '// eslint-disable-next-line -- reason\nreadFileSync(p)\n'],
  ])('a %s fails with path:line', (_label, body) => {
    const root = repo({ ...cleanFiles, 'src/a.ts': `export const a = 1\n${body}` })
    const found = findFsFilenamePolicyViolations(root, pins)
    expect(found).toEqual([expect.objectContaining({ location: 'src/a.ts:2' })])
  })

  it('a wrapped directive in a file whose name holds -<digits>- is still found', () => {
    const root = repo({ ...cleanFiles, 'src/x-1-y.ts': `/* eslint-disable\n  ${RULE} */\n` })
    expect(findFsFilenamePolicyViolations(root, pins)).toEqual([
      expect.objectContaining({ location: 'src/x-1-y.ts:1' }),
    ])
  })

  it('a wrapped disable of a different rule is not a finding', () => {
    const root = repo({ ...cleanFiles, 'src/a.ts': '/* eslint-disable\n  no-console */\n' })
    expect(findFsFilenamePolicyViolations(root, pins)).toEqual([])
  })

  it('a package eslint config that names the rule fails (the policy lives in one place)', () => {
    const root = repo({
      ...cleanFiles,
      'packages/x/eslint.config.js': `export default [{ rules: { '${RULE}': 'off' } }]\n`,
    })
    expect(findFsFilenamePolicyViolations(root, pins)).toEqual([
      expect.objectContaining({ location: 'packages/x/eslint.config.js:1' }),
    ])
  })

  it.each([
    ['a re-export', "export { readFileSync as read } from 'node:fs'\n"],
    ['a default export', 'export default function f(): void {}\n'],
    ['a class export', 'export class Files {}\n'],
  ])('a pinned module with %s fails', (_label, extra) => {
    const root = repo({ ...cleanFiles, [KIT]: `${GOOD_MODULE}${extra}` })
    expect(findFsFilenamePolicyViolations(root, pins).map((f) => f.location)).toEqual([`${KIT}:10`])
  })

  it('an export after a plain block comment cannot borrow the Reason: of an earlier export', () => {
    const borrowed = `${GOOD_MODULE}/* plain\n */\nexport function g(): void {}\n`
    const root = repo({ ...cleanFiles, [KIT]: borrowed })
    expect(findFsFilenamePolicyViolations(root, pins).map((f) => f.location)).toEqual([`${KIT}:12`])
  })

  it('an empty Reason: line does not count', () => {
    const empty = GOOD_MODULE.replace(/ \* Reason:.*\n/, ' * Reason:\n')
    const root = repo({ ...cleanFiles, [KIT]: empty })
    expect(findFsFilenamePolicyViolations(root, pins).map((f) => f.location)).toEqual([`${KIT}:7`])
  })

  it('a disable of a different rule is not a finding', () => {
    const root = repo({
      ...cleanFiles,
      'src/a.ts': '// eslint-disable-next-line no-console\nconsole.log(1)\n',
    })
    expect(findFsFilenamePolicyViolations(root, pins)).toEqual([])
  })

  it('a mention of the rule that is not a directive (config off entry) is not a finding', () => {
    const root = repo({
      ...cleanFiles,
      'cfg.js': `export default { rules: { '${RULE}': 'off' } }\n`,
    })
    expect(findFsFilenamePolicyViolations(root, pins)).toEqual([])
  })

  it('an unpinned fs-access module fails (the exemption is a pinned list)', () => {
    const root = repo({ ...cleanFiles, 'apps/api/src/evil/fs-access.ts': GOOD_MODULE })
    expect(findFsFilenamePolicyViolations(root, pins)).toEqual([
      expect.objectContaining({ location: 'apps/api/src/evil/fs-access.ts' }),
    ])
  })

  it('a pinned module that does not exist fails', () => {
    const root = repo({ [SHIPPED]: GOOD_MODULE })
    expect(findFsFilenamePolicyViolations(root, pins)).toEqual([
      expect.objectContaining({ location: KIT, reason: 'pinned fs-access module does not exist' }),
    ])
  })

  it('an exported function without a Reason: line fails, naming it', () => {
    const noReason = GOOD_MODULE.replace(/ \* Reason:.*\n/, '')
    const root = repo({ ...cleanFiles, [KIT]: noReason })
    expect(findFsFilenamePolicyViolations(root, pins)).toEqual([
      expect.objectContaining({
        location: `${KIT}:6`,
        reason: expect.stringContaining('readText'),
      }),
    ])
  })

  it('an exported function with no JSDoc at all fails', () => {
    const bare = `${GOOD_MODULE}export const exists = (p: string): boolean => p.length > 0\n`
    const root = repo({ ...cleanFiles, [KIT]: bare })
    expect(findFsFilenamePolicyViolations(root, pins).map((f) => f.location)).toEqual([`${KIT}:10`])
  })

  it('the shipped guard module may import only node: modules', () => {
    const bad = `import { x } from './other.js'\nimport { y } from 'svelte/compiler'\n${GOOD_MODULE}`
    const root = repo({ ...cleanFiles, [SHIPPED]: bad })
    expect(findFsFilenamePolicyViolations(root, pins).map((f) => f.location)).toEqual([
      `${SHIPPED}:1`,
      `${SHIPPED}:2`,
    ])
  })

  it('the kit module is not subject to the node:-only import rule', () => {
    const root = repo({ ...cleanFiles, [KIT]: `import { z } from './paths.js'\n${GOOD_MODULE}` })
    expect(findFsFilenamePolicyViolations(root, pins)).toEqual([])
  })
})

describe('the lint policy through the real ESLint engine (AC-1, AC-4)', () => {
  const eslint = new ESLint({ cwd: new URL('..', import.meta.url).pathname })
  const READ =
    "import { readFileSync } from 'node:fs'\nexport const f = (p: string) => readFileSync(p, 'utf8')\n"

  async function fires(filePath: string): Promise<boolean> {
    const [result] = await eslint.lintText(READ, { filePath })
    return (result?.messages ?? []).some((message) => message.ruleId === RULE)
  }

  it.each([
    'packages/composition-kit/src/example.test.ts',
    'packages/composition-kit/tests/example-helpers.ts',
    'apps/api/src/__tests__/example.ts',
    'apps/web/src/lib/test/example.ts',
    'scripts/example.test.ts',
  ])('is off for test file %s', async (path) => {
    expect(await fires(path)).toBe(false)
  })

  it.each([
    'packages/composition-kit/src/example.ts',
    'apps/api/src/example.ts',
    'apps/web/guards/example.ts',
    'scripts/example.ts',
  ])('still fires for production source %s', async (path) => {
    expect(await fires(path)).toBe(true)
  })

  it('is off for the pinned fs-access modules only', async () => {
    for (const module of FS_ACCESS_MODULES) expect(await fires(module), module).toBe(false)
    expect(await fires('apps/api/src/other/fs-access-helper.ts')).toBe(true)
  })
})

describe('self-wiring (AC-7)', () => {
  const command = 'pnpm vitest run scripts/check-fs-filename-policy.test.ts'
  it('the guard and its test run in make ci-inner, ci.yml and package.json', () => {
    const recipe = makeRecipe(makefile, 'ci-inner')
    expect(recipeRunsCommand(recipe, 'pnpm check-fs-filename-policy')).toBe(true)
    expect(recipeRunsCommand(recipe, command)).toBe(true)
    expect(recipe).toContain('scripts/check-fs-filename-policy.test.ts')
    const steps = workflowRunCommands(ciWorkflow).join('\n')
    expect(steps).toContain('pnpm check-fs-filename-policy')
    expect(steps).toContain('scripts/check-fs-filename-policy.test.ts')
    expect(
      (JSON.parse(packageJson) as { scripts: Record<string, string> }).scripts[
        'check-fs-filename-policy'
      ]
    ).toBe('tsx scripts/check-fs-filename-policy.ts')
  })

  it('the real repository is clean', () => {
    const root = new URL('..', import.meta.url).pathname
    expect(findFsFilenamePolicyViolations(root)).toEqual([])
  })
})
