import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/svelte'
import { createRawSnippet } from 'svelte'

import AssetTable from './AssetTable.svelte'

// The shell only ever receives <tr> children from its consumer pages; a raw snippet stands in for
// them so these tests exercise the shell itself rather than any one list page.
const rowsSnippet = createRawSnippet(() => ({
  render: () => '<tr><td>row cell</td></tr>',
}))

// Story 18.13: AssetTable gained a caption, scope="col", per-column header classes, and a
// focusable scroll region. Those were previously only exercised transitively through the four
// list-page tests, which meant the decisions documented in the component's own comments (notably
// keying the header {#each} by index rather than label) had nothing defending them.
function renderTable(props: Record<string, unknown> = {}) {
  return render(AssetTable, {
    props: {
      caption: 'Widgets monitored in this project',
      columns: ['Name', 'URL'],
      canManage: false,
      children: rowsSnippet,
      ...props,
    },
  })
}

describe('AssetTable', () => {
  afterEach(() => cleanup())

  it('renders the caption as the sr-only table name and as the scroll region label', () => {
    const { container } = renderTable()
    const caption = container.querySelector('caption')
    expect(caption?.textContent?.trim()).toBe('Widgets monitored in this project')
    expect(caption?.className).toMatch(/\bsr-only\b/)

    const region = container.querySelector('[role="region"]')
    expect(region?.getAttribute('aria-label')).toBe('Widgets monitored in this project')
  })

  it('makes the horizontal scroll area keyboard reachable', () => {
    const { container } = renderTable()
    const region = container.querySelector('[role="region"]')
    expect(region?.className).toMatch(/\boverflow-x-auto\b/)
    // Without a tab stop the columns a narrow viewport pushes out of view are unreachable
    // (axe: scrollable-region-focusable).
    expect(region?.getAttribute('tabindex')).toBe('0')
  })

  it('marks every header cell with scope="col"', () => {
    const { container } = renderTable({ canManage: true })
    const headers = Array.from(container.querySelectorAll('thead th'))
    expect(headers.map((th) => th.textContent?.trim())).toEqual(['Name', 'URL', 'Actions'])
    for (const th of headers) expect(th.getAttribute('scope')).toBe('col')
  })

  it('omits the Actions header when the role cannot manage', () => {
    const { container } = renderTable({ canManage: false })
    const headers = Array.from(container.querySelectorAll('thead th'))
    expect(headers.map((th) => th.textContent?.trim())).toEqual(['Name', 'URL'])
  })

  it('applies a column headerClass to its own <th> and leaves plain-string columns alone', () => {
    const { container } = renderTable({
      columns: [{ label: 'Endpoint', headerClass: 'w-1/3' }, 'Status'],
    })
    const headers = Array.from(container.querySelectorAll('thead th'))
    expect(headers[0]?.className).toMatch(/\bw-1\/3\b/)
    expect(headers[1]?.className).not.toMatch(/\bw-1\/3\b/)
    // The shared padding/weight survives the concatenation in both forms.
    for (const th of headers) expect(th.className).toMatch(/\bfont-semibold\b/)
  })

  it('renders duplicate column labels instead of throwing each_key_duplicate', () => {
    // The header {#each} is keyed by index on purpose: a caller repeating a label is a cosmetic
    // mistake, not a reason for Svelte to throw and blank the whole route.
    const { container } = renderTable({ columns: ['Domain', 'Domain'] })
    const headers = Array.from(container.querySelectorAll('thead th'))
    expect(headers.map((th) => th.textContent?.trim())).toEqual(['Domain', 'Domain'])
  })
})
