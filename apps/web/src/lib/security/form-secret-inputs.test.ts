import { describe, expect, it } from 'vitest'
import { basename } from 'node:path'
import { assertNotVacuous, guardSources, readGuardSource } from '../test/guard-root.js'

/**
 * @pv-guard form-secret-inputs
 *
 * Story 66.3 AC-11 (Red Team): a `<form>` without `method` submits with GET. If a submit lands
 * before hydration attaches the Svelte `onsubmit` handler (or the JS never loads), the browser
 * navigates to `<current-url>?<name>=<value>…` — so every NAMED input ends up in the URL, the
 * browser history, access/proxy logs and later `Referer` headers.
 *
 * Two layers, both enforced here (Story 66.3 decision; Nestor asked for
 * the second on top of the first):
 * 1. Secret inputs never carry a `name` — nothing secret is ever part of a native submission.
 *    The forms submit through `onsubmit` handlers that read bound state, so `name` had no use.
 * 2. Every form that contains a secret input — directly, or through a component that renders one
 *    outside a form of its own (e.g. `FieldSetEditor`) — declares `method="post"`, so even a
 *    future named input would go into the request body, never the URL. None of these routes has
 *    a form action, so a pre-hydration native POST gets SvelteKit's 405 rendered as the app's
 *    error page: no echo, no 500, no secret anywhere.
 */

type Tag = { name: string; start: number; source: string }

type ScanState = { depth: number; quote: string | null }

/** Advances the quote/brace state by one character; returns true on the tag's closing `>`. */
function closesTag(char: string, state: ScanState): boolean {
  if (state.quote) {
    if (char === state.quote) state.quote = null
    return false
  }
  if (char === '"' || char === "'") state.quote = char
  else if (char === '{') state.depth += 1
  else if (char === '}') state.depth -= 1
  return char === '>' && state.depth === 0
}

/** Index of the `>` closing the opening tag that starts before `from`. Attribute values may hold
 * Svelte expressions containing `>` (e.g. `onclick={() => x}`), so it is the first `>` outside
 * quotes and outside `{…}`. */
function tagEnd(source: string, from: number): number {
  const state: ScanState = { depth: 0, quote: null }
  let end = from
  while (end < source.length && !closesTag(source.charAt(end), state)) end += 1
  return end
}

/** Every `<input …>`, `<textarea …>` and `<form …>` opening tag. */
function openingTags(source: string): Tag[] {
  const tags: Tag[] = []
  const pattern = /<(input|textarea|form)\b/g
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    const end = tagEnd(source, match.index + match[0].length)
    tags.push({
      name: match[1] ?? '',
      start: match.index,
      source: source.slice(match.index, end + 1),
    })
  }
  return tags
}

type AttributeName = 'name' | 'id' | 'type' | 'method' | 'aria-label'

// One literal pattern per attribute: `attr="…"`, `attr='…'` or `attr={…}`.
const ATTRIBUTE_PATTERNS = new Map<AttributeName, RegExp>([
  ['name', /\sname=(?:"([^"]*)"|'([^']*)'|\{([^}]*)\})/],
  ['id', /\sid=(?:"([^"]*)"|'([^']*)'|\{([^}]*)\})/],
  ['type', /\stype=(?:"([^"]*)"|'([^']*)'|\{([^}]*)\})/],
  ['method', /\smethod=(?:"([^"]*)"|'([^']*)'|\{([^}]*)\})/],
  ['aria-label', /\saria-label=(?:"([^"]*)"|'([^']*)'|\{([^}]*)\})/],
])

function attribute(tag: string, name: AttributeName): string | null {
  const match = ATTRIBUTE_PATTERNS.get(name)?.exec(tag)
  return match ? (match[1] ?? match[2] ?? match[3] ?? '') : null
}

const SECRET_WORDS = /pass(word|phrase)|secret|token|credential-value/i

/** A password-typed input (static or `type={… 'password'}`), or one whose name/id/aria-label
 * marks it as a secret. Radio groups such as `kmsType`/`unsealMode` do not match. */
function isSecretInput(tag: string): boolean {
  const type = attribute(tag, 'type') ?? ''
  if (/password/.test(type)) return true
  return (['name', 'id', 'aria-label'] as AttributeName[]).some((attr) =>
    SECRET_WORDS.test(attribute(tag, attr) ?? '')
  )
}

/** Secret inputs that carry a `name` (layer 1). */
function namedSecretInputs(source: string): string[] {
  return openingTags(source)
    .filter((tag) => tag.name !== 'form')
    .filter((tag) => isSecretInput(tag.source) && attribute(tag.source, 'name') !== null)
    .map((tag) => attribute(tag.source, 'name') ?? '')
}

type FormSpan = { start: number; end: number; opening: string }

function formSpans(source: string): FormSpan[] {
  return openingTags(source)
    .filter((tag) => tag.name === 'form')
    .map((tag) => {
      const close = source.indexOf('</form>', tag.start)
      return { start: tag.start, end: close === -1 ? source.length : close, opening: tag.source }
    })
}

function componentUsed(body: string, component: string): boolean {
  const opening = `<${component}`
  for (let at = body.indexOf(opening); at !== -1; at = body.indexOf(opening, at + 1)) {
    const next = body.charAt(at + opening.length)
    if (next === '' || /[\s/>]/.test(next)) return true
  }
  return false
}

/** True when `body` holds a secret input, or renders one of `exposingComponents`. */
function holdsSecret(body: string, exposingComponents: ReadonlySet<string>): boolean {
  return (
    openingTags(body).some((tag) => tag.name !== 'form' && isSecretInput(tag.source)) ||
    [...exposingComponents].some((component) => componentUsed(body, component))
  )
}

/** Forms holding a secret that do not declare `method="post"` (layer 2); `formIndex` names them. */
function secretFormsWithoutPost(
  source: string,
  exposingComponents: ReadonlySet<string> = new Set()
): number[] {
  return formSpans(source)
    .map((form, formIndex) => ({ form, formIndex }))
    .filter(({ form }) => holdsSecret(source.slice(form.start, form.end), exposingComponents))
    .filter(({ form }) => !/^post$/i.test(attribute(form.opening, 'method') ?? ''))
    .map(({ formIndex }) => formIndex)
}

/** Source with every `<form>…</form>` span removed. */
function outsideForms(source: string): string {
  return formSpans(source)
    .reverse()
    .reduce((rest, form) => rest.slice(0, form.start) + rest.slice(form.end), source)
}

/** Components that render a secret input outside a form of their own — so the form they are
 * placed in holds that secret. Resolved to a fixed point (a wrapper of such a component is one
 * too). */
function secretExposingComponents(files: ReadonlyMap<string, string>): Set<string> {
  const exposing = new Set<string>()
  let grew = true
  while (grew) {
    grew = false
    for (const [file, source] of files) {
      const component = basename(file, '.svelte')
      if (component.startsWith('+') || exposing.has(component)) continue
      if (holdsSecret(outsideForms(source), exposing)) {
        exposing.add(component)
        grew = true
      }
    }
  }
  return exposing
}

describe('secret inputs never reach a URL through a native form submission (AC-11)', () => {
  it('layer 1 flags every named secret input, and nothing else', () => {
    expect(
      namedSecretInputs(
        '<form onsubmit={() => submit()}><input type="password" name="passphrase" /></form>'
      )
    ).toEqual(['passphrase'])
    expect(
      namedSecretInputs(
        `<form><input id="x" type={reveal ? 'text' : 'password'} name="credential-value" /></form>`
      )
    ).toEqual(['credential-value'])
    expect(namedSecretInputs('<form><input id="vault-bootstrap-token" name="t" /></form>')).toEqual(
      ['t']
    )
    expect(
      namedSecretInputs('<form method="POST"><input type="password" name="passphrase" /></form>')
    ).toEqual(['passphrase'])
    expect(
      namedSecretInputs(
        '<form><input type="password" /><input type="radio" name="kmsType" /></form>'
      )
    ).toEqual([])
  })

  it('layer 2 flags a form holding a secret without method="post", directly or via a component', () => {
    expect(secretFormsWithoutPost('<form><input type="password" /></form>')).toEqual([0])
    expect(secretFormsWithoutPost('<form method="post"><input type="password" /></form>')).toEqual(
      []
    )
    expect(
      secretFormsWithoutPost(
        '<form method="post"><input type="text" /></form><form><input type="text" /></form>'
      )
    ).toEqual([])
    expect(
      secretFormsWithoutPost(
        '<form><Editor bind:fields /></form><form><Other /></form>',
        new Set(['Editor'])
      )
    ).toEqual([0])
    expect(
      secretExposingComponents(
        new Map([
          ['a/Editor.svelte', '<input type="password" />'],
          ['a/Wrapper.svelte', '<div><Editor /></div>'],
          ['a/OwnForm.svelte', '<form method="post"><input type="password" /></form>'],
          ['a/+page.svelte', '<input type="password" />'],
        ])
      )
    ).toEqual(new Set(['Editor', 'Wrapper']))
  })

  it('holds for every Svelte component in the tree under test (PV src, or a composed app root)', () => {
    const sources = guardSources(/\.svelte$/)
    assertNotVacuous(sources)
    const files = new Map(sources.map((source) => [source.path, readGuardSource(source)]))
    const exposing = secretExposingComponents(files)
    const offenders = [...files].flatMap(([file, source]) => [
      ...namedSecretInputs(source).map((name) => `${file}: name="${name}"`),
      ...secretFormsWithoutPost(source, exposing).map(
        (index) => `${file}: form #${index + 1} has no method="post"`
      ),
    ])
    expect(offenders).toEqual([])
  })
})
