import { describe, expect, it } from 'vitest'

// Story 59.2 AC-3: the "html is shown on every action outcome" rule used to live only in TSDoc
// and the package CHANGELOG. This doc-drift guard keeps the extension-author guide's
// `ActionResult` outcome table in step with the `ActionResult` union: adding or removing a
// variant without updating `docs/extensions/authoring.md` fails CI.

// The live files, read at transform time by Vite as raw text: the lint-clean loading pattern of
// check-action-pins.test.ts (no non-literal fs paths).
const LIVE_FILES: Record<string, string> = import.meta.glob(
  [
    '../packages/extension-api/src/hooks/module-action.ts',
    '../docs/extensions/authoring.md',
    '../docs/extensions/README.md',
  ],
  { query: '?raw', import: 'default', eager: true }
)

export const MODULE_ACTIONS_HEADING = '### Module actions and ActionResult'
export const MODULE_ACTIONS_ANCHOR = 'module-actions-and-actionresult'

const ACTION_RESULT_DECLARATION = 'export type ActionResult ='
const OUTCOME_LITERAL_RE = /outcome:\s*['"]([\w-]+)['"]/g
const OUTCOME_KEY_RE = /\boutcome\??:/g

/** Returns the `outcome` literals of the `export type ActionResult =` union, bounded to that
 * declaration (it ends at the first blank line or the next `export`). Throws when the declaration
 * is missing or yields no outcome, so a broken extractor can never pass vacuously. */
export function extractActionResultOutcomes(source: string): string[] {
  const start = source.indexOf(ACTION_RESULT_DECLARATION)
  if (start === -1) {
    throw new Error(`no "${ACTION_RESULT_DECLARATION}" declaration found`)
  }
  const body = source.slice(start + ACTION_RESULT_DECLARATION.length)
  const endCandidates = [body.indexOf('\n\n'), body.indexOf('\nexport ')].filter((i) => i !== -1)
  const declaration = endCandidates.length > 0 ? body.slice(0, Math.min(...endCandidates)) : body
  const outcomes = [...declaration.matchAll(OUTCOME_LITERAL_RE)].map((match) => match[1])
  if (outcomes.length === 0) {
    throw new Error(`"${ACTION_RESULT_DECLARATION}" declares no outcome literal`)
  }
  // Every `outcome` key must have been read as a literal, so a variant written in a shape the
  // regex does not match fails loudly instead of silently dropping out of the check.
  const outcomeKeys = [...declaration.matchAll(OUTCOME_KEY_RE)].length
  if (outcomeKeys !== outcomes.length) {
    throw new Error(
      `"${ACTION_RESULT_DECLARATION}" has ${outcomeKeys} outcome keys but ${outcomes.length} readable literals`
    )
  }
  return outcomes
}

/** Returns the markdown from `heading` up to the next `### ` or `## ` heading, or undefined when
 * the heading is absent. */
export function sectionOf(markdown: string, heading: string): string | undefined {
  const lines = markdown.split('\n')
  const start = lines.findIndex((line) => line.trim() === heading)
  if (start === -1) return undefined
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => line.startsWith('### ') || line.startsWith('## '))
  return (end === -1 ? rest : rest.slice(0, end)).join('\n')
}

/** Lists the outcomes that do not appear as a `` | `<name>` | `` table cell inside the section
 * named `heading`. Throws when the section itself is missing. */
export function outcomesMissingFromSection(
  markdown: string,
  heading: string,
  outcomes: readonly string[]
): string[] {
  const section = sectionOf(markdown, heading)
  if (section === undefined) {
    throw new Error(`section "${heading}" is missing from the authoring guide`)
  }
  return outcomes.filter((outcome) => !section.includes(`| \`${outcome}\` |`))
}

/** GitHub-style heading slug: lowercase, punctuation dropped, spaces to hyphens. */
export function githubSlug(headingText: string): string {
  return headingText
    .trim()
    .toLowerCase()
    .replaceAll(/[^\w\s-]/g, '')
    .replaceAll(/\s/g, '-')
}

/** True when some markdown heading (any level) slugs to `anchor`. */
export function hasHeadingWithSlug(markdown: string, anchor: string): boolean {
  return markdown
    .split('\n')
    .map((line) => /^#{1,6}\s+(.+)$/.exec(line)?.[1])
    .some((text) => text !== undefined && githubSlug(text) === anchor)
}

const DENIED_VARIANT = "  | { outcome: 'denied'; html?: string }"

const FIXTURE_UNION = [
  '/** docs mentioning { outcome: `ok` } are ignored */',
  'export type ActionResult =',
  "  | { outcome: 'ok'; html?: string }",
  DENIED_VARIANT,
  '',
  'export type Other = { outcome: "unrelated" }',
].join('\n')

const FIXTURE_DOC = [
  '## Guidance',
  '',
  MODULE_ACTIONS_HEADING,
  '',
  '| `outcome` | Status |',
  '|---|---|',
  '| `ok` | 200 |',
  '| `denied` | 403 |',
  '',
  '### Next section',
  '',
  '| `rate_limited` | 429 |',
].join('\n')

describe('extension authoring doc drift guard: fixtures', () => {
  it('extracts only the outcomes of the ActionResult union', () => {
    expect(extractActionResultOutcomes(FIXTURE_UNION)).toEqual(['ok', 'denied'])
  })

  it('reports a union variant missing from the section, by name', () => {
    const union = FIXTURE_UNION.replace(
      DENIED_VARIANT,
      "  | { outcome: 'denied'; html?: string }\n  | { outcome: 'rate_limited'; html?: string }"
    )
    const outcomes = extractActionResultOutcomes(union)
    expect(outcomes).toContain('rate_limited')
    expect(outcomesMissingFromSection(FIXTURE_DOC, MODULE_ACTIONS_HEADING, outcomes)).toEqual([
      'rate_limited',
    ])
  })

  it('fails naming the heading when the section is missing', () => {
    expect(() =>
      outcomesMissingFromSection('## Guidance\n', MODULE_ACTIONS_HEADING, ['ok'])
    ).toThrow(MODULE_ACTIONS_HEADING)
  })

  it('is section-bounded: an outcome elsewhere in the file does not count', () => {
    // `rate_limited` appears as a table cell only in the NEXT section of FIXTURE_DOC.
    expect(
      outcomesMissingFromSection(FIXTURE_DOC, MODULE_ACTIONS_HEADING, ['rate_limited'])
    ).toEqual(['rate_limited'])
  })

  it('never passes vacuously when there is no ActionResult declaration', () => {
    expect(() => extractActionResultOutcomes('export type Other = { outcome: "x" }')).toThrow(
      /no "export type ActionResult =" declaration/
    )
    expect(() => extractActionResultOutcomes('export type ActionResult = never\n')).toThrow(
      /declares no outcome literal/
    )
  })

  it('fails loudly on an outcome it cannot read as a literal', () => {
    const union = FIXTURE_UNION.replace(
      DENIED_VARIANT,
      "  | { outcome: 'denied'; html?: string }\n  | { outcome: RateLimited; html?: string }"
    )
    expect(() => extractActionResultOutcomes(union)).toThrow(/3 outcome keys but 2 readable/)
    expect(extractActionResultOutcomes(FIXTURE_UNION.replace("'denied'", '"denied"'))).toEqual([
      'ok',
      'denied',
    ])
  })

  it('slugs the heading to the documented anchor', () => {
    expect(githubSlug('Module actions and ActionResult')).toBe(MODULE_ACTIONS_ANCHOR)
    expect(hasHeadingWithSlug(FIXTURE_DOC, MODULE_ACTIONS_ANCHOR)).toBe(true)
    expect(hasHeadingWithSlug('## Other\n', MODULE_ACTIONS_ANCHOR)).toBe(false)
  })
})

describe('extension authoring doc drift guard: live files', () => {
  const read = (path: string): string => {
    const text = LIVE_FILES[`../${path}`]
    expect(text, `${path} must be loadable`).toBeDefined()
    return text ?? ''
  }
  const moduleActionSource = read('packages/extension-api/src/hooks/module-action.ts')
  const authoringGuide = read('docs/extensions/authoring.md')
  const hookCatalogue = read('docs/extensions/README.md')

  it('reads the current ActionResult variants', () => {
    expect(new Set(extractActionResultOutcomes(moduleActionSource))).toEqual(
      new Set(['ok', 'validation_failed', 'denied', 'conflict', 'error'])
    )
  })

  it('documents every ActionResult outcome in the authoring guide section', () => {
    const outcomes = extractActionResultOutcomes(moduleActionSource)
    expect(outcomesMissingFromSection(authoringGuide, MODULE_ACTIONS_HEADING, outcomes)).toEqual([])
  })

  it('links the hook catalogue to an existing authoring-guide anchor', () => {
    expect(hookCatalogue).toContain(`authoring.md#${MODULE_ACTIONS_ANCHOR}`)
    expect(hasHeadingWithSlug(authoringGuide, MODULE_ACTIONS_ANCHOR)).toBe(true)
  })
})
