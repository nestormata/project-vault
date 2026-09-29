import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Story 66.3 AC-11 (Red Team): a `<form>` without `method` submits with GET. If a submit lands
 * before hydration attaches the Svelte `onsubmit` handler (or the JS never loads), the browser
 * navigates to `<current-url>?<name>=<value>…` — so every NAMED input ends up in the URL, the
 * browser history, access/proxy logs and later `Referer` headers. A secret input must therefore
 * never carry a `name` unless its form posts (`method="post"` sends the body, not the URL).
 *
 * Chosen pattern (recorded in Story 66.3's Dev Notes): secret inputs stay unnamed. The forms
 * submit through their `onsubmit` handler reading bound state, so `name` served no purpose, and
 * dropping it changes nothing a user sees — unlike `method="post"` on a route with no form
 * actions, which would answer a pre-hydration submit with a 405 error page.
 */

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

function svelteFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (entry === 'paraglide') return []
    if (statSync(path).isDirectory()) return svelteFiles(path)
    return path.endsWith('.svelte') ? [path] : []
  })
}

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

function enclosingFormPosts(source: string, tags: Tag[], position: number): boolean {
  const form = tags.filter((tag) => tag.name === 'form' && tag.start < position).at(-1)
  if (!form || source.slice(form.start, position).includes('</form>')) return false
  return /^post$/i.test(attribute(form.source, 'method') ?? '')
}

/** Named secret inputs that are not inside a `method="post"` form in the same component. */
function namedSecretInputsOutsidePostForms(source: string): string[] {
  const tags = openingTags(source)
  return tags
    .filter((tag) => tag.name !== 'form')
    .filter((tag) => isSecretInput(tag.source) && attribute(tag.source, 'name') !== null)
    .filter((tag) => !enclosingFormPosts(source, tags, tag.start))
    .map((tag) => attribute(tag.source, 'name') ?? '')
}

describe('secret inputs never reach a URL through a native GET form submission (AC-11)', () => {
  it('flags a named password input in a method-less form, and nothing else', () => {
    expect(
      namedSecretInputsOutsidePostForms(
        '<form onsubmit={() => submit()}><input type="password" name="passphrase" /></form>'
      )
    ).toEqual(['passphrase'])
    expect(
      namedSecretInputsOutsidePostForms(
        `<form><input id="x" type={reveal ? 'text' : 'password'} name="credential-value" /></form>`
      )
    ).toEqual(['credential-value'])
    expect(
      namedSecretInputsOutsidePostForms(
        '<form><input id="vault-bootstrap-token" name="t" /></form>'
      )
    ).toEqual(['t'])
    expect(
      namedSecretInputsOutsidePostForms(
        '<form method="POST"><input type="password" name="passphrase" /></form>'
      )
    ).toEqual([])
    expect(
      namedSecretInputsOutsidePostForms(
        '<form><input type="password" /><input type="radio" name="kmsType" /></form>'
      )
    ).toEqual([])
  })

  it('holds for every Svelte component in apps/web/src', () => {
    const offenders = svelteFiles(sourceRoot).flatMap((file) =>
      namedSecretInputsOutsidePostForms(readFileSync(file, 'utf-8')).map(
        (name) => `${relative(sourceRoot, file)}: name="${name}"`
      )
    )
    expect(offenders).toEqual([])
  })
})
