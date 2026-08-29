import { afterEach, describe, expect, it, vi } from 'vitest'
import DOMPurify from 'dompurify'
import { renderPanelHtml } from './render-panel-html.js'

// Story 29.1 — the sanitize-and-inject Svelte action. This is the highest-value test file in
// this story (Dev Notes "Testing Standards"): it is the only thing standing between an
// extension HTML-generation bug and a real XSS in PV's own session, since there is no iframe
// sandbox boundary any more (AC4/AC13).

function makeContainer(): HTMLDivElement {
  const el = document.createElement('div')
  document.body.appendChild(el)
  return el
}

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('renderPanelHtml action (Story 29.1)', () => {
  it('(a) benign HTML passes through with content intact', () => {
    const el = makeContainer()
    renderPanelHtml(el, '<p>hello <strong>world</strong></p>')

    expect(el.innerHTML).toContain('hello')
    expect(el.querySelector('strong')?.textContent).toBe('world')
  })

  it('(b) a <script> tag is stripped', () => {
    const el = makeContainer()
    renderPanelHtml(el, '<p>hi</p><script>window.__pwned = true</script>')

    expect(el.querySelector('script')).toBeNull()
    expect(el.innerHTML).not.toContain('__pwned')
  })

  it('(c) an onerror/onclick attribute is stripped', () => {
    const el = makeContainer()
    renderPanelHtml(
      el,
      '<img src="x" onerror="window.__pwned=true"><button onclick="evil()">Go</button>'
    )

    expect(el.querySelector('img')?.getAttribute('onerror')).toBeNull()
    expect(el.querySelector('button')?.getAttribute('onclick')).toBeNull()
  })

  it('(d) a javascript: URL in an href/src is neutralized', () => {
    const el = makeContainer()
    renderPanelHtml(el, '<a href="javascript:alert(1)">click</a>')

    const href = el.querySelector('a')?.getAttribute('href') ?? ''
    expect(href.toLowerCase()).not.toContain('javascript:')
  })

  it('(e) a nested iframe/object/embed is stripped', () => {
    const el = makeContainer()
    renderPanelHtml(
      el,
      '<iframe src="https://evil.example"></iframe><object data="evil.swf"></object><embed src="evil.swf">'
    )

    expect(el.querySelector('iframe')).toBeNull()
    expect(el.querySelector('object')).toBeNull()
    expect(el.querySelector('embed')).toBeNull()
  })

  it('Story 29.1 Task 5 (AC12 mitigation): a <style> block is stripped, so extension CSS cannot leak page-wide once there is no iframe document boundary', () => {
    const el = makeContainer()
    renderPanelHtml(el, '<style>body { display: none !important; }</style><p>content</p>')

    expect(el.querySelector('style')).toBeNull()
    expect(el.textContent).toContain('content')
  })

  it('Story 29.1 Task 5 (AC12 mitigation): a <link rel="stylesheet"> is stripped', () => {
    const el = makeContainer()
    renderPanelHtml(
      el,
      '<link rel="stylesheet" href="https://evil.example/style.css"><p>content</p>'
    )

    expect(el.querySelector('link')).toBeNull()
  })

  it('(f) a target="_blank" link gets rel="noopener noreferrer" forced onto it', () => {
    const el = makeContainer()
    renderPanelHtml(el, '<a href="https://example.com" target="_blank">out</a>')

    expect(el.querySelector('a')?.getAttribute('rel')).toBe('noopener noreferrer')
  })

  it('(f) an existing rel value on a target="_blank" link is overwritten to enforce noopener noreferrer', () => {
    const el = makeContainer()
    renderPanelHtml(el, '<a href="https://example.com" target="_blank" rel="bogus">out</a>')

    expect(el.querySelector('a')?.getAttribute('rel')).toBe('noopener noreferrer')
  })

  it('(g) the action re-renders correctly across several rapid successive parameter values (slot A -> B -> C)', () => {
    const el = makeContainer()
    renderPanelHtml(el, '<p>slot-a</p>')
    renderPanelHtml(el, '<p>slot-b</p>')
    renderPanelHtml(el, '<p>slot-c</p>')

    expect(el.innerHTML).toContain('slot-c')
    expect(el.innerHTML).not.toContain('slot-a')
    expect(el.innerHTML).not.toContain('slot-b')
  })

  it('(h) null input renders nothing / clears prior content', () => {
    const el = makeContainer()
    renderPanelHtml(el, '<p>something</p>')
    expect(el.innerHTML).toContain('something')

    renderPanelHtml(el, null)
    expect(el.innerHTML).toBe('')
  })

  it("(i) '' (empty string) input renders an empty container without being treated as the degraded/null case", () => {
    const el = makeContainer()
    renderPanelHtml(el, '<p>something</p>')

    renderPanelHtml(el, '')
    expect(el.innerHTML).toBe('')
  })

  it('(j) a forced sanitizer exception is caught and degrades gracefully rather than throwing', () => {
    const el = makeContainer()
    const spy = vi.spyOn(DOMPurify, 'sanitize').mockImplementation(() => {
      throw new Error('boom')
    })

    expect(() => renderPanelHtml(el, '<p>x</p>')).not.toThrow()
    expect(el.innerHTML).toBe('')
    spy.mockRestore()
  })

  it('(k) a realistic fixture of CM panel HTML survives sanitization with its legitimate content intact', () => {
    const el = makeContainer()
    // Story 29.2 — modeled on fixtures/mock-ui-panel-extension/src/index.ts's real
    // onRenderPanel() output shape: inline style using a --pv-ext-* CSS var with a fallback, and
    // a declaratively-wired action button using the data-pv-action/data-pv-action-<field>
    // convention (no inline <script> any more — DOMPurify strips every <script> unconditionally,
    // and the host now discovers/dispatches actions via these plain data-* attributes instead).
    const realisticFixture =
      `<html><body>` +
      `<p style="color: var(--pv-ext-ink, #24323b); background: var(--pv-ext-surface, #ffffff);">Mock panel for slot "group"</p>` +
      `<button type="button" data-pv-action="test-action" data-pv-action-note="fixture-note">Run test action</button>` +
      `</body></html>`

    renderPanelHtml(el, realisticFixture)

    expect(el.querySelector('script')).toBeNull()
    expect(el.textContent).toContain('Mock panel for slot "group"')
    const button = el.querySelector('[data-pv-action]')
    expect(button).not.toBeNull()
    expect(button?.textContent).toBe('Run test action')
    expect(button?.getAttribute('data-pv-action')).toBe('test-action')
    expect(button?.getAttribute('data-pv-action-note')).toBe('fixture-note')
    const p = el.querySelector('p[style]')
    expect(p?.getAttribute('style')).toContain('--pv-ext-ink')
  })

  it('a Svelte action object with destroy() does not throw on a normal unmount with no pending async work', () => {
    const el = makeContainer()
    const action = renderPanelHtml(el, '<p>x</p>')

    expect(() => action?.destroy?.()).not.toThrow()
  })

  it('a Svelte action object supports update() re-sanitizing a new value', () => {
    const el = makeContainer()
    const action = renderPanelHtml(el, '<p>first</p>')

    action?.update?.('<p>second</p>')

    expect(el.innerHTML).toContain('second')
    expect(el.innerHTML).not.toContain('first')
  })

  // Regression (found via manual Chrome verification, not caught by any jsdom-based test above,
  // since jsdom always provides a `window`): `DOMPurify.addHook()` used to be called at MODULE
  // scope, unconditionally, on import. SvelteKit's SSR bundle imports this module too — even
  // though `renderPanelHtml` itself, a `use:` action, never executes server-side — and Node's
  // `dompurify` export (no real DOM) has no `addHook` method at all, unlike the browser bundle's
  // window-bound instance. That crashed every server-rendered request to the panel route with
  // `TypeError: DOMPurify.addHook is not a function`. The fix defers hook registration to inside
  // `sanitizeAndAssign` (first real, client-side sanitize call) rather than module scope. This
  // test asserts `addHook` is not called merely by importing the module — only when a sanitize
  // call actually happens.
  it('does not call DOMPurify.addHook merely on import (regression: crashed SSR, no window there)', async () => {
    // Isolated via vi.doMock + vi.resetModules rather than spying on the real, shared `dompurify`
    // singleton — other tests in this file already trigger sanitize calls (and therefore hook
    // registration) on that shared instance, so a spy on it here could never observe a clean
    // "not called on import" state. A fake purify stub sidesteps that entirely.
    vi.resetModules()
    const addHook = vi.fn()
    const sanitize = vi.fn().mockReturnValue('')
    vi.doMock('dompurify', () => ({ default: { addHook, sanitize } }))

    await import('./render-panel-html.js')

    expect(addHook).not.toHaveBeenCalled()

    vi.doUnmock('dompurify')
    vi.resetModules()
  })
})
