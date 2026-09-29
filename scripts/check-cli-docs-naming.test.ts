import { describe, expect, it } from 'vitest'

// Story 43.14 AC-8: the CLI ships as `pvault` (Story 43.1 decision #1), yet the planning text and
// several docs kept saying `pv get`/`pv run` and the entry-point guides never linked the CLI. The
// drift was only caught by the Epic 43 retrospective. This guard keeps the public docs, the CLI
// source and the user-facing CLI surfaces in step with the binary name and the registered
// subcommands.
//
// Deliberately NOT scanned (so nobody "fixes" the scope later):
// - CHANGELOG.md: history is immutable; a past entry may legitimately quote an old name.
// - scripts/**: this guard's own fixtures contain `pv get` by design; scripts/ holds no user docs.
// - _bmad-output/**: private overlay, absent in public CI (epics.md/prd.md are checked by grep).
// - node_modules, dist/, packages/vault-action/dist/**: generated or third-party.
// - the rest of apps/web: no other web file mentions the CLI today; an eager raw glob over the
//   whole app would slow the guard for no present benefit.

// Read at transform time by Vite as raw text: the lint-clean loading pattern of
// check-action-pins.test.ts (no non-literal fs paths). `**` stands in for the `(app)` route group:
// `(`/`)` are extglob syntax and must never be written in a glob.
const SCANNED_FILES: Record<string, string> = import.meta.glob(
  [
    '../README.md',
    '../docs/**/*.md',
    '../packages/*/README.md',
    '../packages/cli/src/**/*.ts',
    '../packages/cli/package.json',
    '../.github/workflows/cli-release.yml',
    '../apps/web/src/lib/components/platform/CliVersionPolicySection.svelte',
    '../apps/web/src/lib/platform/cli-version-policy-view.ts',
    '../apps/web/src/routes/**/platform/upgrade/+page.svelte',
  ],
  { query: '?raw', import: 'default', eager: true }
)

const SCANNED = new Map(Object.entries(SCANNED_FILES))

const ROOT_README = '../README.md'
const CLI_PACKAGE_JSON = '../packages/cli/package.json'
const CLI_SOURCE = '../packages/cli/src/cli.ts'
const CLI_README = '../packages/cli/README.md'

/** Exact files that must be present in the glob result (anti-vacuity). */
const REQUIRED_EXACT_FILES = [
  ROOT_README,
  CLI_README,
  CLI_SOURCE,
  CLI_PACKAGE_JSON,
  '../.github/workflows/cli-release.yml',
  '../apps/web/src/lib/components/platform/CliVersionPolicySection.svelte',
  '../apps/web/src/lib/platform/cli-version-policy-view.ts',
]

/** Entry-point docs that must link the CLI README (check e). */
export const ENTRY_POINT_DOCS = [
  ROOT_README,
  '../docs/README.md',
  '../docs/machine-users.md',
  '../docs/api-consumers.md',
]

/**
 * A `pv <subcommand>` CLI invocation. Case-sensitive (the capitalised product abbreviation `PV`
 * is not the CLI). The left boundary class keeps `npv`, `mypv` and `/usr/bin/pv` out; the right
 * `(?![\w-])` (not `\b`) makes `-V`/`--help`/`--version`/`write-env` end cleanly and keeps
 * `pv get-foo`/`pv runner` out. Kept a literal: a runtime-built regex would need a lint
 * suppression, so check (d) ties this alternation to the registered subcommands instead.
 */
export const PV_INVOCATION =
  /(^|[\s`'"(>|])pv (get|run|login|logout|write-env|--version|-V|--help)(?![\w-])/gm

const COMMANDER_SUBCOMMAND = /\.command\(\s*['"]([a-z][a-z-]*)['"]/g
const PV_INVOCATION_ALTERNATION = /pv \(([^)]*)\)/
// `README.md` must be followed by `)` or an anchor's `#`: the link target ends there.
const CLI_README_LINK = /\]\((?:\.\.\/)*packages\/cli\/README\.md[#)]/

export interface PvInvocationHit {
  line: number
  text: string
}

/** Returns every `pv <subcommand>` invocation in `text`, with its 1-based line number. */
export function findPvInvocations(text: string): PvInvocationHit[] {
  const lines = text.split('\n')
  return [...text.matchAll(PV_INVOCATION)].map((match) => {
    // The left-boundary group may itself be a newline, so count from the `pv` token, not the match.
    const line = text.slice(0, match.index + match[1].length).split('\n').length
    return { line, text: lines[line - 1].trim() }
  })
}

/** Returns every `.command('<name>')` literal in a commander program source. Throws when none is
 * found, so an empty or unreadable source can never pass vacuously. */
export function extractCommanderSubcommands(source: string): string[] {
  const names = [...source.matchAll(COMMANDER_SUBCOMMAND)].map((match) => match[1])
  if (names.length === 0) {
    throw new Error('no .command(<name>) registration found in the CLI source')
  }
  return names
}

/** Returns the subcommand alternation of `PV_INVOCATION`, read from its own source. */
export function pvInvocationAlternatives(): string[] {
  const group = PV_INVOCATION_ALTERNATION.exec(PV_INVOCATION.source)
  if (!group) {
    throw new Error('PV_INVOCATION has no `pv (...)` alternation')
  }
  return group[1].split('|')
}

/** True when `markdown` contains a Markdown link to `packages/cli/README.md` (any depth of `../`,
 * optional anchor). Bare path text is not a link. */
export function hasCliReadmeLink(markdown: string): boolean {
  return CLI_README_LINK.test(markdown)
}

/** True when the README documents `` `pvault <name>`` followed by a space or a backtick. */
export function readmeDocumentsSubcommand(readme: string, name: string): boolean {
  return readme.includes('`pvault ' + name + ' ') || readme.includes('`pvault ' + name + '`')
}

function scanned(path: string): string {
  const content = SCANNED.get(path)
  if (content === undefined) {
    throw new Error(`${path} was not loaded by the guard's glob`)
  }
  return content
}

describe('findPvInvocations', () => {
  it.each([
    ['run `pv get DATABASE_URL`', 1],
    ['$ pv run -- ./x', 1],
    ['pv --version', 1],
    ['pv -V', 1],
    ['pv --help', 1],
    ['| pv write-env |', 1],
    ['<code>pv login</code>', 1],
    ['(pv logout)', 1],
    ['`pvault get X`', 0],
    ['`pv` ("Pipe Viewer") is a Unix utility', 0],
    ["LVM2's `pv*` command family", 0],
    ['--pv-ext-accent', 0],
    ['data-pv-action', 0],
    ['pv-instance.ts', 0],
    ['pvk_', 0],
    ['pv:1234', 0],
    ['PV get', 0],
    ['PV run', 0],
    ['npv get', 0],
    ['mypv run', 0],
    ['/usr/bin/pv get', 0],
    ['pv get-foo', 0],
    ['pv runner', 0],
  ])('%j has %i hit(s)', (input, expected) => {
    expect(findPvInvocations(input)).toHaveLength(expected)
  })

  it('accepted false negative: `pv  get` with two spaces is not matched', () => {
    expect(findPvInvocations('pv  get X')).toEqual([])
  })

  it('reports the line number of a hit after the first line', () => {
    expect(findPvInvocations('line one\npv get X')).toEqual([{ line: 2, text: 'pv get X' }])
  })
})

describe('extractCommanderSubcommands', () => {
  it('reads multi-line commander registrations with either quote style', () => {
    expect(
      extractCommanderSubcommands('program\n  .command(\'get\')\n  .command("write-env")')
    ).toEqual(['get', 'write-env'])
  })

  it('throws on a source with no registration', () => {
    expect(() => extractCommanderSubcommands('')).toThrow(/no \.command/)
  })
})

describe('hasCliReadmeLink', () => {
  it('accepts a relative link with an anchor', () => {
    expect(hasCliReadmeLink('[x](../packages/cli/README.md#version-check-story-436)')).toBe(true)
  })

  it('accepts a root-relative link', () => {
    expect(hasCliReadmeLink('[packages/cli](packages/cli/README.md)')).toBe(true)
  })

  it('rejects bare path text that is not a link', () => {
    expect(hasCliReadmeLink('packages/cli/README.md')).toBe(false)
  })
})

describe('readmeDocumentsSubcommand', () => {
  it('accepts the name followed by a space or a backtick', () => {
    expect(readmeDocumentsSubcommand('`pvault run -- x`', 'run')).toBe(true)
    expect(readmeDocumentsSubcommand('`pvault logout`', 'logout')).toBe(true)
  })

  it('rejects a longer command sharing the prefix', () => {
    expect(readmeDocumentsSubcommand('`pvault getter`', 'get')).toBe(false)
  })
})

describe('real tree (Story 43.14 AC-8)', () => {
  it('loads every scanned file (anti-vacuity)', () => {
    const paths = [...SCANNED.keys()]
    for (const path of REQUIRED_EXACT_FILES) {
      expect(paths, path).toContain(path)
    }
    expect(
      paths.filter((p) => p.startsWith('../docs/') && p.endsWith('.md')).length
    ).toBeGreaterThan(10)
    expect(
      paths.some((p) => /^\.\.\/packages\/[^/]+\/README\.md$/.test(p) && p !== CLI_README)
    ).toBe(true)
    expect(paths.some((p) => p.startsWith('../packages/cli/src/') && p !== CLI_SOURCE)).toBe(true)
    expect(
      paths.some(
        (p) =>
          p.startsWith('../apps/web/src/routes/') && p.endsWith('/platform/upgrade/+page.svelte')
      )
    ).toBe(true)
  })

  it('(a) packages/cli/package.json declares exactly one binary, `pvault`', () => {
    const manifest = JSON.parse(scanned(CLI_PACKAGE_JSON)) as { bin?: Record<string, string> }
    if (manifest.bin === undefined) {
      throw new Error('packages/cli/package.json has no `bin`')
    }
    expect(Object.keys(manifest.bin)).toEqual(['pvault'])
  })

  it('(b) no scanned file invokes the CLI as `pv <subcommand>`', () => {
    const hits = [...SCANNED]
      .filter(([path]) => path !== CLI_PACKAGE_JSON)
      .flatMap(([path, content]) =>
        findPvInvocations(content).map((hit) => `${path.slice(3)}:${hit.line}: ${hit.text}`)
      )
    expect(hits).toEqual([])
  })

  it('(c) packages/cli/README.md documents every registered subcommand as `pvault <name>`', () => {
    const subcommands = extractCommanderSubcommands(scanned(CLI_SOURCE))
    expect(subcommands.length).toBeGreaterThanOrEqual(5)
    const readme = scanned(CLI_README)
    const undocumented = subcommands.filter((name) => !readmeDocumentsSubcommand(readme, name))
    expect(undocumented).toEqual([])
  })

  it('(d) PV_INVOCATION covers every registered subcommand', () => {
    const alternatives = pvInvocationAlternatives()
    const missing = extractCommanderSubcommands(scanned(CLI_SOURCE)).filter(
      (name) => !alternatives.includes(name)
    )
    expect(missing).toEqual([])
  })

  it('(e) every entry-point doc links packages/cli/README.md', () => {
    const unlinked = ENTRY_POINT_DOCS.filter((path) => !hasCliReadmeLink(scanned(path)))
    expect(unlinked).toEqual([])
  })
})
