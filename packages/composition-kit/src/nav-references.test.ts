// Story 68.7 AC-9 (Q8): compose-time reading of a pack's `nav.ts`. Every string-literal id an
// operation names is recorded with its surface (the delta key it sits under): targets and anchors
// are operative except the targets of hide/remove; the ids the pack inserts are "declared". A
// non-literal id is a note (the shipped composed-nav test checks it in CI), never a failure.
import * as ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { extractNavReferences } from './nav-references.js'

const PRIMARY = 'primary'
const PROJECTS = 'primary.projects'
const BILLING = 'cm.billing'
const extract = (code: string) => extractNavReferences(code, ts, 'nav.ts', ['primary', 'project'])

describe('extractNavReferences (Story 68.7 AC-9)', () => {
  it('reads builder calls and plain op objects, with operative flags and declared ids', () => {
    const result = extract(`
import { defineNavDelta, hide, insert, move, relabel, remove, reorder, replace } from '@project-vault/composition-kit/nav'
const nested = { id: 'cm.deep', label: 'D', children: [{ id: 'cm.deep.a', label: 'A' }] }
export default defineNavDelta({
  primary: [
    insert({ after: 'primary.projects', item: { id: 'cm.billing', label: 'B', children: [{ id: 'cm.billing.x', label: 'X' }] } }),
    insert({ parent: 'primary', item: nested }),
    hide('primary.health'),
    remove('primary.gone'),
    relabel('primary.secrets', () => 'Vault'),
    move('primary.settings', { parent: 'cm.billing' }),
    replace('primary.search', { label: 'Find' }),
    reorder('primary', ['primary.projects', 'cm.billing']),
    { op: 'hide', id: 'primary.notifications' },
    { op: 'move', id: 'primary.dashboard', before: 'primary.projects' },
  ],
  'project': [insert({ parent: 'project.members', item: { id: 'cm.p', label: 'P' } })],
})
`)
    expect(result.problems).toEqual([])
    expect(
      result.references.map(({ id, operative, surface }) => ({ id, operative, surface }))
    ).toEqual([
      { id: PROJECTS, operative: true, surface: PRIMARY },
      { id: 'primary.health', operative: false, surface: PRIMARY },
      { id: 'primary.gone', operative: false, surface: PRIMARY },
      { id: 'primary.secrets', operative: true, surface: PRIMARY },
      { id: 'primary.settings', operative: true, surface: PRIMARY },
      { id: BILLING, operative: true, surface: PRIMARY },
      { id: 'primary.search', operative: true, surface: PRIMARY },
      { id: PROJECTS, operative: true, surface: PRIMARY },
      { id: BILLING, operative: true, surface: PRIMARY },
      { id: 'primary.notifications', operative: false, surface: PRIMARY },
      { id: 'primary.dashboard', operative: true, surface: PRIMARY },
      { id: PROJECTS, operative: true, surface: PRIMARY },
      { id: 'project.members', operative: true, surface: 'project' },
    ])
    expect(result.declared).toEqual([
      { id: BILLING, surface: PRIMARY },
      { id: 'cm.billing.x', surface: PRIMARY },
      { id: 'cm.p', surface: 'project' },
    ])
    expect(result.notes).toEqual([
      'nav.ts:7:39: insert item is not an object literal; its ids are not statically checked (the composed nav test checks them)',
      'nav references: 16 literal, 1 not statically checked',
    ])
  })

  it('notes a non-literal id argument with its position, never fails', () => {
    const result = extract(`
import { hide, move } from '@project-vault/composition-kit/nav'
const id = 'primary.health'
export default { primary: [hide(id), move(\`primary.\${'x'}\`, { parent: 'cm.ops' })] }
`)
    expect(result.problems).toEqual([])
    expect(result.references).toEqual([
      { id: 'cm.ops', operative: true, surface: 'primary', op: 'move', role: 'anchor' },
    ])
    expect(result.notes).toEqual([
      'nav id argument at nav.ts:4:33 is not a string literal; the composed nav test checks it',
      'nav id argument at nav.ts:4:43 is not a string literal; the composed nav test checks it',
      'nav references: 1 literal, 2 not statically checked',
    ])
  })

  it('counts ops built outside the delta literal (spreads, helpers) as not statically checked', () => {
    const result = extract(`
const ops = [{ op: 'hide', id: 'primary.health' }]
export default { primary: [...ops, makeOp()] }
`)
    expect(result.notes.at(-1)).toBe('nav references: 1 literal, 2 not statically checked')
  })

  it("records the children a replace declares as the pack's own ids, not host references", () => {
    // 68-7 review: a replacement that declares children inserts those ids, so an op anchored on
    // one of them is not a reference to a (vanished) web-host id.
    const result = extract(`
import { insert, replace } from '@project-vault/composition-kit/nav'
export default {
  primary: [
    replace('primary.settings', { label: 'S', children: [{ id: 'cm.s.a', label: 'A', children: [{ id: 'cm.s.a.b', label: 'B' }] }] }),
    { op: 'replace', id: 'primary.health', item: { label: 'H', children: [{ id: 'cm.h', label: 'X' }] } },
    insert({ after: 'cm.s.a', item: { id: 'cm.after', label: 'N' } }),
  ],
}
`)
    expect(result.problems).toEqual([])
    expect(result.declared).toEqual([
      { id: 'cm.s.a', surface: PRIMARY },
      { id: 'cm.s.a.b', surface: PRIMARY },
      { id: 'cm.h', surface: PRIMARY },
      { id: 'cm.after', surface: PRIMARY },
    ])
  })

  it('reports a syntax error with its file and line', () => {
    const result = extract("export default { primary: [hide('x') }\n")
    expect(result.problems).toEqual([expect.stringMatching(/^nav\.ts:1:\d+: /)])
  })
})
