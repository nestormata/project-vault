import { describe, expect, it } from 'vitest'
import { type GraphResolver } from './import-graph.js'
import { classifyTest, relativePathLiterals, type TestSelectionContext } from './test-selection.js'

// Story 68.2 (Nestor 2026-10-02): only self-contained unit tests ship. Each rule, on a fixture.

const VITEST_IMPORT = "import { it } from 'vitest'"
const WEB_SRC = '/repo/apps/web/src'
const TEST = `${WEB_SRC}/lib/a.test.ts`

function context(files: Record<string, string>): TestSelectionContext {
  const table = new Map(Object.entries(files))
  const resolver: GraphResolver = {
    alias: (specifier) =>
      specifier === '@project-vault/shared' ? '/repo/packages/shared/src/index.ts' : undefined,
    readFile: (path) => table.get(path),
  }
  return {
    webSrc: WEB_SRC,
    vendoredShared: new Set(['/repo/packages/shared/src/index.ts']),
    lockedPackages: new Set(['vitest', 'zod']),
    publishedWorkspacePackages: new Set(['@project-vault/extension-api']),
    resolver,
    display: (path) => path,
  }
}

const classify = (code: string, extra: Record<string, string> = {}) =>
  classifyTest(TEST, code, context({ [TEST]: code, ...extra }))

describe('classifyTest', () => {
  it('ships a test whose imports and paths stay inside the package', () => {
    const result = classify(
      "import { it } from 'vitest'\nimport { a } from './a'\nimport { s } from '@project-vault/shared'\nimport '@project-vault/extension-api'\nconst f = '../app.css'",
      { [`${WEB_SRC}/lib/a.ts`]: '', '/repo/packages/shared/src/index.ts': "import 'zod'" }
    )
    expect(result).toMatchObject({ selfContained: true, reasons: [] })
    expect(result.bareImports).toEqual(['@project-vault/extension-api', 'vitest', 'zod'])
  })

  it('excludes a test that reads a file outside the package (cli-version-policy-view shape)', () => {
    const result = classify("const policy = resolve(here, '../../../api/src/policy.ts')")
    expect(result.selfContained).toBe(false)
    expect(result.reasons).toEqual(['reads "../../../api/src/policy.ts", outside the package'])
  })

  it('excludes a test that imports a file outside the package', () => {
    const result = classify("import config from '../../../vitest.config'", {
      '/repo/apps/vitest.config.ts': '',
    })
    expect(result.reasons).toContain('imports /repo/apps/vitest.config.ts, outside the package')
  })

  it('excludes a test that imports a workspace fixture or a package apps/web does not resolve', () => {
    expect(classify("import '@project-vault/mock-envelope-extension'").reasons).toEqual([
      'imports the workspace package @project-vault/mock-envelope-extension',
    ])
    expect(classify("import 'left-pad'").reasons).toEqual([
      'imports left-pad, which apps/web does not resolve',
    ])
  })

  it('lists type-only packages in bareImports once, merged with runtime ones (Story 68.22)', () => {
    const result = classify("import { it } from 'vitest'\nimport { h } from './helpers'", {
      [`${WEB_SRC}/lib/helpers.ts`]:
        "import type { f } from 'zod'\nimport type { g } from 'vitest'",
    })
    expect(result.selfContained).toBe(true)
    expect(result.bareImports).toEqual(['vitest', 'zod'])
  })

  it('excludes a test that only type-imports a package apps/web does not resolve (Story 68.22)', () => {
    const result = classify("import type { x } from 'left-pad'")
    expect(result.selfContained).toBe(false)
    expect(result.reasons).toEqual(['imports left-pad, which apps/web does not resolve'])
  })

  it('excludes a test with an unresolvable relative import', () => {
    expect(classify("import './gone'").reasons[0]).toMatch(/^unresolvable import/)
  })

  it("excludes the route render snapshot oracle, which is valid only on PV's own tree", () => {
    const file = `${WEB_SRC}/routes/route-render-snapshot.test.ts`
    const result = classifyTest(file, VITEST_IMPORT, context({ [file]: '' }))
    expect(result.selfContained).toBe(false)
    expect(result.reasons).toEqual([
      "oracle of PV's own un-composed markup; valid only on PV's tree",
    ])
    expect(classify(VITEST_IMPORT).selfContained).toBe(true)
  })

  it('excludes the structural pins of PV own build (hooks files, server files wiring)', () => {
    for (const [name, reason] of [
      ['hooks-files.test.ts', /hooks files with no contributions/],
      ['routes/server-files-wiring.test.ts', /every page and layout server file/],
    ] as const) {
      const file = `${WEB_SRC}/${name}`
      const result = classifyTest(file, VITEST_IMPORT, context({ [file]: '' }))
      expect(result.selfContained, name).toBe(false)
      expect(result.reasons[0], name).toMatch(reason)
    }
  })

  it('ignores relative paths that only appear in comments', () => {
    expect(relativePathLiterals("// see '../../../api/x.ts'\nconst a = './b'")).toEqual(['./b'])
  })
})
