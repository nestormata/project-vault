// @vitest-environment node
/**
 * Story 66.2 guard: keeps `apps/web/e2e/**` and `apps/web/playwright.config.ts` inside a tsc program that
 * the web `typecheck` task (PR CI "Typecheck", `make typecheck`, `make ci`) actually runs. The only things
 * making e2e code type-checked are a package.json script string and a tsconfig `include` list, so this
 * test fails if either is edited away, loosened, or sidestepped (exclude, `.js` rename, moved testDir).
 *
 * Reads source files only (no env, no network) and uses the in-process `typescript` API, never a
 * PATH-resolved `tsc` binary.
 */
import { globSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
// Loaded through Vite (vitest's module graph), not `readFileSync(path)`: a computed fs path trips
// eslint `security/detect-non-literal-fs-filename`, which fails under `--max-warnings=0`.
import webPackage from '../package.json'
import playwrightConfigSource from '../playwright.config.ts?raw'

const WEB_ROOT = fileURLToPath(new URL('../', import.meta.url))
const E2E_ROOT = fileURLToPath(new URL('../e2e/', import.meta.url))
const E2E_TSCONFIG = fileURLToPath(new URL('../e2e/tsconfig.json', import.meta.url))
const PLAYWRIGHT_CONFIG = fileURLToPath(new URL('../playwright.config.ts', import.meta.url))
/** Gitignored Playwright output (`.gitignore`); never holds source, so every listing skips it. */
const IGNORED_DIRS = ['test-results/**']

const webScripts: Record<string, string> = webPackage.scripts

/** Files under `apps/web/e2e/` matching `patterns` (outside `test-results/`), as absolute paths. */
function listE2eFiles(patterns: string[]): string[] {
  return globSync(patterns, { cwd: E2E_ROOT, exclude: IGNORED_DIRS }).map((path) =>
    join(E2E_ROOT, path)
  )
}

function parseE2eConfig(): ts.ParsedCommandLine {
  const parsed = ts.getParsedCommandLineOfConfigFile(E2E_TSCONFIG, undefined, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
    },
  })
  if (parsed === undefined) throw new Error(`could not parse ${E2E_TSCONFIG}`)
  return parsed
}

const PROBE_PATH = join(E2E_ROOT, '__probe__.spec.ts')

/**
 * Type-checks one virtual `e2e/__probe__.spec.ts` (served from memory, never written to disk) with the
 * real e2e compiler options, and returns the diagnostics that belong to the probe file.
 */
function checkProbe(source: string): readonly ts.Diagnostic[] {
  const { options } = parseE2eConfig()
  const host = ts.createCompilerHost(options, true)
  const isProbe = (fileName: string): boolean => fileName === PROBE_PATH
  const baseFileExists = host.fileExists.bind(host)
  const baseReadFile = host.readFile.bind(host)
  const baseGetSourceFile = host.getSourceFile.bind(host)
  host.fileExists = (fileName) => isProbe(fileName) || baseFileExists(fileName)
  host.readFile = (fileName) => (isProbe(fileName) ? source : baseReadFile(fileName))
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) =>
    isProbe(fileName)
      ? ts.createSourceFile(fileName, source, languageVersion, true)
      : baseGetSourceFile(fileName, languageVersion, onError, shouldCreate)

  const program = ts.createProgram({ rootNames: [PROBE_PATH], options, host })
  const probe = program.getSourceFile(PROBE_PATH)
  if (probe === undefined) throw new Error('probe source file was not loaded')
  return [...program.getSyntacticDiagnostics(probe), ...program.getSemanticDiagnostics(probe)]
}

describe('66.2 (a): the web typecheck script runs the e2e program', () => {
  it('typecheck:e2e runs tsc against e2e/tsconfig.json', () => {
    expect(webScripts['typecheck:e2e']).toBe('tsc -p e2e/tsconfig.json --noEmit')
  })

  // Order vs `svelte-kit sync` does not matter: e2e/tsconfig.json is standalone (it does not extend
  // .svelte-kit/tsconfig.json). The one enforced order is "after tsc --noEmit", so a chained `&&`
  // always runs both checks and the root program's failure is reported first.
  it('typecheck invokes typecheck:e2e after tsc --noEmit', () => {
    const typecheck = webScripts.typecheck ?? ''
    const steps = typecheck.split('&&').map((step) => step.trim())
    const rootCheck = steps.indexOf('tsc --noEmit')
    const e2eCheck = steps.indexOf('pnpm run typecheck:e2e')
    expect(rootCheck, `typecheck script: ${typecheck}`).toBeGreaterThanOrEqual(0)
    expect(e2eCheck, `typecheck script: ${typecheck}`).toBeGreaterThan(rootCheck)
  })
})

describe('66.2 (b): the e2e program covers every e2e source and stays strict', () => {
  it('includes every *.ts file under e2e/ (outside test-results/) and playwright.config.ts', () => {
    const programFiles = new Set(
      parseE2eConfig().fileNames.map((fileName) => ts.sys.resolvePath(fileName))
    )
    const expected = [...listE2eFiles(['**/*.ts']), PLAYWRIGHT_CONFIG].map((path) =>
      ts.sys.resolvePath(path)
    )
    expect(expected.length).toBeGreaterThan(1)
    const missing = expected.filter((path) => !programFiles.has(path))
    expect(missing).toEqual([])
  })

  it('keeps strict and noUncheckedIndexedAccess on, and has no exclude key', () => {
    const parsed = parseE2eConfig()
    expect(parsed.options.strict).toBe(true)
    expect(parsed.options.noUncheckedIndexedAccess).toBe(true)
    const raw = parsed.raw as Record<string, unknown>
    expect(Object.keys(raw)).not.toContain('exclude')
  })
})

describe('66.2 (b2): no e2e source escapes the program by extension', () => {
  it('has no .js/.mjs/.cjs/.mts/.cts file under e2e/ (outside test-results/)', () => {
    const optOuts = listE2eFiles(['**/*.js', '**/*.mjs', '**/*.cjs', '**/*.mts', '**/*.cts'])
    expect(optOuts.map((path) => path.slice(WEB_ROOT.length))).toEqual([])
  })
})

describe('66.2 (b3): Playwright runs the tree the program checks', () => {
  // Text match on purpose: importing the config would run defineConfig and read env.
  const configSource = playwrightConfigSource

  it("sets testDir to './e2e'", () => {
    expect(configSource).toMatch(/^\s*testDir:\s*'\.\/e2e',?\s*$/m)
  })

  it('points globalSetup and globalTeardown under ./e2e/', () => {
    expect(configSource).toMatch(/^\s*globalSetup:\s*'\.\/e2e\/[^']+\.ts',?\s*$/m)
    expect(configSource).toMatch(/^\s*globalTeardown:\s*'\.\/e2e\/[^']+\.ts',?\s*$/m)
  })
})

describe('66.2 (c): a Playwright API misuse fails the e2e program', () => {
  const probeFor = (call: string): string =>
    `import { test } from '@playwright/test'\ntest('p', async ({ page }) => {\n  await ${call}\n})\n`

  // getByLabelText is a Testing Library API Playwright has never had (the j28 bug, PR #456), so this
  // probe does not rot with Playwright releases.
  it('reports exactly one TS2551 for page.getByLabelText', () => {
    const diagnostics = checkProbe(probeFor("page.getByLabelText('x')"))
    expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([2551])
    const [only] = diagnostics
    expect(ts.flattenDiagnosticMessageText(only?.messageText, '\n')).toContain('getByLabelText')
  })

  // Positive twin: proves the host resolves @playwright/test, so a TS2307 can never pass the probe above.
  it('reports no diagnostics for page.getByLabel', () => {
    const diagnostics = checkProbe(probeFor("page.getByLabel('x')"))
    expect(
      diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
    ).toEqual([])
  })
})
