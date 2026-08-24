import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { composePanelDocument } from './compose-panel-document.js'
import { BASE_EXTENSION_THEME_VARS } from './extension-theme-vars.js'

// Story 25.4 AC3 — style isolation is already structurally guaranteed by the sandboxed
// `<iframe srcdoc>`'s separate-`Document` model, not newly built. This is a regression-test AC:
// it pins the two structural facts that make that guarantee true, so a future reader never has to
// re-derive them from first principles.

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
// false-positive on this story's own doc comments mentioning "iframe srcdoc" etc.
function styleContent(file: string): string {
  const raw = readFileSync(file, 'utf-8')
  if (file.endsWith('.css')) return raw
  return [...raw.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((match) => match[1]).join('\n')
}

describe('panel style isolation (Story 25.4 AC3)', () => {
  it('(a) no apps/web stylesheet/component selector targets panel-internal content — only the iframe element itself may be styled from the outside', () => {
    const iframeInternalSelectorPattern = /iframe\s*(>|\s)\s*[a-zA-Z.#[]/

    const offendingFiles = sourceFiles(sourceRoot)
      .filter((file) => iframeInternalSelectorPattern.test(styleContent(file)))
      // The panel route's own iframe element itself may carry sizing/border classes as
      // attributes (title=/sandbox=/srcdoc=/class=) — that is styling the element from the
      // outside, exactly the property this test allows; it never matches the descendant-selector
      // pattern above (no `iframe .foo` / `iframe > .foo` construct exists anywhere).
      .map((file) => file.replace(`${sourceRoot}/`, ''))

    expect(offendingFiles).toEqual([])
  })

  it('(b) the composed srcdoc document never includes a <link rel="stylesheet"> or any apps/web-authored <style> sourced from the compiled CSS bundle', () => {
    const composed = composePanelDocument(
      '<p class="cm-button">extension content</p>',
      BASE_EXTENSION_THEME_VARS
    )

    expect(composed).not.toContain('<link')
    expect(composed).not.toContain('rel="stylesheet"')
    // The only <style> block ever injected is this story's own --pv-ext-* :root {} block — never
    // a reference to apps/web's own compiled Tailwind/component CSS bundle.
    expect(composed.match(/<style>/g)).toHaveLength(1)
    expect(composed).not.toContain('/_app/')
  })

  it('(b edge) a class name collision with a real CentralizeMe class (.cm-button) does not cause apps/web to emit any panel-targeting selector', () => {
    const collidingSelectorPattern = /\.cm-button\b/

    const offendingFiles = sourceFiles(sourceRoot)
      .filter((file) => collidingSelectorPattern.test(styleContent(file)))
      .map((file) => file.replace(`${sourceRoot}/`, ''))

    expect(offendingFiles).toEqual([])
  })
})
