/**
 * @pv-not-guard a pin of PV's own shared-controls border (the ui/ constant) in PV's own components; a pack that
 * replaces one of them is a subject change, so this test may be excluded with its subject.
 *
 * Story 72.4 guard: the D-10 control border (`CONTROL_BORDER`) is adopted by every form control and
 * outlined button of the PV routes. A control that goes back to the old `border-slate-300` (1.48:1 on
 * white, WCAG 1.4.11) fails here. Decorative boxes (cards, dashed empty states, `kbd`, spinners) are
 * not controls and are not scanned.
 */
import { describe, expect, it } from 'vitest'
import { CONTROL_BORDER } from './control-classes.js'

const sources = import.meta.glob('/src/**/*.svelte', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

const CONTROL_TAGS = new Set(['input', 'select', 'textarea', 'button', 'a'])
const OLD_BORDER = /(?<![\w:-])border-slate-300(?![\w-])/g

/** Not migrated by 72.4: CM replaces two of them (GlobalSearch, ShellBrand) and the nav stories own the rest. */
const NOT_MIGRATED = new Set([
  '/src/lib/components/shell/GlobalSearch.svelte',
  '/src/lib/components/shell/PrimaryNav.svelte',
  '/src/lib/components/shell/ShellAccount.svelte',
])

function enclosingTag(source: string, index: number): string | null {
  const open = source.lastIndexOf('<', index)
  if (open < 0 || open < source.lastIndexOf('>', index)) return null
  return /^<([A-Za-z][\w.:-]*)/.exec(source.slice(open))?.[1] ?? null
}

describe('control border adoption (Story 72.4)', () => {
  it('scans the route components', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(100)
  })

  it('no migrated form control or outlined button keeps the old border', () => {
    const offenders: string[] = []
    for (const [path, source] of Object.entries(sources)) {
      if (NOT_MIGRATED.has(path)) continue
      for (const match of source.matchAll(OLD_BORDER)) {
        const tag = enclosingTag(source, match.index)
        if (tag !== null && CONTROL_TAGS.has(tag)) {
          const line = source.slice(0, match.index).split('\n').length
          offenders.push(`${path}:${line} <${tag}>`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('the literal written in the components is the shared token', () => {
    const literal = 'border-[color:var(--color-border-strong,#64748b)]'
    expect(CONTROL_BORDER).toBe(literal)
    const users = Object.values(sources).filter((source) => source.includes(literal))
    expect(users.length).toBeGreaterThan(60)
  })

  it('the not-migrated list only names files that still exist', () => {
    for (const path of NOT_MIGRATED) expect(Object.keys(sources)).toContain(path)
  })
})
