import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderPanelHtml } from './render-panel-html.js'

// Story 25.4 AC3 (original) — style isolation used to be structurally guaranteed by the
// sandboxed `<iframe srcdoc>`'s separate-`Document` model: apps/web's own compiled Tailwind CSS
// bundle physically could not reach into the iframe's document, and nothing an extension put in
// its own `<style>` block could reach back out into apps/web's chrome, either.
//
// Story 29.1 Task 5 (AC12) — that structural guarantee is GONE now that the panel renders
// directly into apps/web's own document (no iframe, no separate Document). This is an accepted,
// explicitly-documented regression, not silently dropped:
//
// - apps/web's own compiled CSS cascade now reaches whatever the panel renders (e.g. a global
//   `p { color: red }` rule in some future apps/web stylesheet would now visibly affect panel
//   content it never touched before). This story does not add any such global selector today
//   (test (a) below still holds, unchanged), but nothing structurally prevents one from being
//   added later the way the iframe boundary once did.
// - An extension's own returned HTML COULD, in principle, carry inline `style="..."` attributes
//   or arbitrary class names that happen to collide with apps/web's own utility classes (test
//   (b edge) below still holds, unchanged) — inherited/cascaded properties (e.g. `color`,
//   `font-family` set on an ancestor) can still bleed into panel content either way, iframe or
//   not, since CSS inheritance was never something the iframe boundary blocked in the first
//   place; document-scoped rules (selectors, `!important` overrides, page-wide side effects) are
//   the part the iframe boundary WAS blocking and this story cannot fully restore without
//   reintroducing an isolation boundary (Shadow DOM, out of scope — see Dev Notes/AC9).
//
// The concrete, testable mitigation this story DOES add (`render-panel-html.ts`'s `FORBID_TAGS`
// including `style`/`link`, beyond AC13's own `iframe`/`object`/`embed` requirement): an
// extension's HTML can no longer inject a `<style>` block or an external `<link
// rel="stylesheet">` into apps/web's own document at all — the single highest-severity part of
// the lost isolation guarantee (a panel's own returned HTML directly rewriting apps/web's global
// styles, or loading arbitrary third-party CSS) is closed, even though full bidirectional
// isolation is not restored.

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (entry === 'paraglide') return []
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.(svelte|css)$/.test(path) && !/\.test\.ts$/.test(path) ? [path] : []
  })
}

// Only real stylesheet content is in scope — a .css file's whole content, or a .svelte file's
// <style> block(s) — never prose/comments elsewhere in a .ts/.svelte file, which would otherwise
// false-positive on this story's own doc comments mentioning "iframe"/selectors etc.
function styleContent(file: string): string {
  const raw = readFileSync(file, 'utf-8')
  if (file.endsWith('.css')) return raw
  return [...raw.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((match) => match[1]).join('\n')
}

describe('panel style isolation (Story 25.4 AC3, re-evaluated by Story 29.1 Task 5/AC12)', () => {
  it('(a) no apps/web stylesheet/component selector targets panel-internal content — unchanged property, still holds regardless of the rendering mechanism', () => {
    // The pattern below used to be scoped to "iframe descendant selectors" specifically, since
    // an iframe was the only element that could ever wrap panel content. Now that the panel
    // renders into a plain container, the equivalent, still-meaningful check is: no apps/web
    // stylesheet targets the panel's own container class or a CentralizeMe-authored class name
    // (see (b edge) below) — apps/web's own hand-authored source contains no such selector today.
    const panelTargetingSelectorPattern = /\.mt-6\.overflow-hidden\s*(>|\s)\s*[a-zA-Z.#[]/

    const offendingFiles = sourceFiles(sourceRoot)
      .filter((file) => panelTargetingSelectorPattern.test(styleContent(file)))
      .map((file) => file.replace(`${sourceRoot}/`, ''))

    expect(offendingFiles).toEqual([])
  })

  it('(b) a <style> block in extension-returned HTML is stripped before it ever reaches the DOM — the highest-severity part of the lost isolation guarantee is closed', () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    try {
      renderPanelHtml(
        el,
        '<style>body { display: none !important; } .mt-6 { border: none !important; }</style><p class="cm-button">extension content</p>'
      )

      expect(el.querySelector('style')).toBeNull()
      expect(document.querySelectorAll('style')).toHaveLength(0)
    } finally {
      document.body.removeChild(el)
    }
  })

  it('(b) a <link rel="stylesheet"> in extension-returned HTML is stripped — apps/web never loads an extension-supplied external stylesheet', () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    try {
      renderPanelHtml(el, '<link rel="stylesheet" href="https://evil.example/style.css">')

      expect(el.querySelector('link')).toBeNull()
    } finally {
      document.body.removeChild(el)
    }
  })

  it('(b edge) a class name collision with a real CentralizeMe class (.cm-button) does not cause apps/web to emit any panel-targeting selector', () => {
    const collidingSelectorPattern = /\.cm-button\b/

    const offendingFiles = sourceFiles(sourceRoot)
      .filter((file) => collidingSelectorPattern.test(styleContent(file)))
      .map((file) => file.replace(`${sourceRoot}/`, ''))

    expect(offendingFiles).toEqual([])
  })
})
