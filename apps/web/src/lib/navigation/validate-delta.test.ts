// Story 68.7 AC-7: `validateNavDelta` checks integrity only (it is what the shipped composed-nav
// test and the dev-mode check run). It is never an allowlist: hiding every PV item, removing PV's
// settings entry, replacing sign-out or nesting PV items under CM groups all validate cleanly.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'svelte/compiler'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { NAV_IDS } from './nav-registry.js'
import { validateNavDelta } from './validate-delta.js'

describe('validateNavDelta (Story 68.7 AC-7)', () => {
  it('an empty delta has no problems and no notes', () => {
    expect(validateNavDelta({})).toEqual({ problems: [], notes: [] })
  })

  it('never refuses a deliberate change: hide everything, remove settings, replace sign-out, nest dashboard', () => {
    const hideAll: Record<string, unknown[]> = {}
    for (const entry of NAV_IDS) {
      hideAll[entry.surface] ??= []
      hideAll[entry.surface]?.push({ op: 'hide', id: entry.id })
    }
    hideAll.primary?.push(
      { op: 'remove', id: 'primary.settings' },
      { op: 'insert', parent: 'primary', item: { id: 'cm.group', label: 'CM', children: [] } },
      { op: 'move', id: 'primary.dashboard', parent: 'cm.group' }
    )
    hideAll.account?.push({
      op: 'replace',
      id: 'account.sign-out',
      item: { label: 'Leave', kind: 'action', onSelect: () => undefined },
    })
    const result = validateNavDelta(hideAll)
    expect(result.problems).toEqual([])
  })

  it('reports an unknown surface key, a non-array value and a non-object delta', () => {
    expect(validateNavDelta({ sidebar: [], primary: 'x' }).problems).toEqual([
      'nav delta surface "primary" must be an array of operations',
      'unknown nav surface "sidebar"',
    ])
    expect(validateNavDelta([]).problems).toEqual(['nav delta must be an object of surfaces'])
    expect(validateNavDelta(null).problems).toEqual(['nav delta must be an object of surfaces'])
  })

  it('names the owning surface when an op targets an id of another surface (Q4)', () => {
    expect(validateNavDelta({ primary: [{ op: 'hide', id: 'project.members' }] }).notes).toEqual([
      'primary: op 1 (hide) nav id "project.members" does not exist; nothing to hide',
    ])
    expect(
      validateNavDelta({ primary: [{ op: 'relabel', id: 'project.members', label: 'x' }] }).problems
    ).toEqual([
      'primary: op 1 (relabel) nav id "project.members" belongs to surface "project", not "primary"',
    ])
  })

  it('treats prototype keys as grammar problems and pollutes nothing', () => {
    const delta = JSON.parse(
      '{"__proto__": [{"op":"hide","id":"primary.health"}], "constructor": [], "primary": [{"op":"insert","parent":"primary","item":{"id":"constructor","label":"x"}}]}'
    ) as unknown
    const result = validateNavDelta(delta)
    expect(result.problems).toEqual([
      'nav delta surface key "__proto__" breaks the id grammar',
      'nav delta surface key "constructor" breaks the id grammar',
      'primary: op 1 (insert) nav id "constructor" breaks the id grammar',
    ])
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(Object.getPrototypeOf({})).toBe(Object.prototype)
  })

  it('adds the AGPL source-offer note when the footer source or license link is changed (Q12)', () => {
    const result = validateNavDelta({
      footer: [
        { op: 'hide', id: 'footer.license' },
        {
          op: 'replace',
          id: 'footer.github',
          item: { label: 'Source', kind: 'external', href: () => 'https://example.com' },
        },
      ],
    })
    expect(result.problems).toEqual([])
    expect(result.notes).toEqual([
      'footer: the delta changes footer.github; check AGPL-3.0 §13 source-offer obligations (see DW-127/DW-225)',
      'footer: the delta changes footer.license; check AGPL-3.0 §13 source-offer obligations (see DW-127/DW-225)',
    ])
  })

  it('a legacy navItems id is not addressable (Q2a): unknown in surface primary', () => {
    expect(
      validateNavDelta({ primary: [{ op: 'relabel', id: 'ext-a', label: 'x' }] }).problems
    ).toEqual(['primary: op 1 (relabel) unknown nav id "ext-a"'])
  })
})

/** The identifiers and string/template literals of a file's code (comments are prose and may say
 * "no allowlist"). A `.svelte` file contributes its script blocks and its markup text. */
function codeTokens(code: string, svelte = false): string {
  if (svelte) {
    const ast = parse(code, { modern: true })
    const scripts = [ast.instance, ast.module].flatMap((script) =>
      script === null || script === undefined ? [] : [code.slice(script.start, script.end)]
    )
    return scripts.map((script) => codeTokens(script)).join(' ')
  }
  const source = ts.createSourceFile('x.ts', code, ts.ScriptTarget.Latest, true)
  const tokens: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) || ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node)) {
      tokens.push(node.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return tokens.join(' ')
}

describe('no allowlist-shaped construct in the nav code (Story 68.7 AC-7)', () => {
  it('apps/web/src/lib/navigation holds no ALLOWED_/allowlist/PROTECTED_IDS', () => {
    expect(codeTokens('// allowlist\nconst x = 1')).not.toMatch(/allowlist/)
    expect(codeTokens('const ALLOWED_IDS = []')).toMatch(/ALLOWED_/)
    const dir = import.meta.dirname
    const files = readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter(
      (file) => /\.(ts|svelte)$/.test(file) && !file.endsWith('.test.ts')
    )
    expect(files.length).toBeGreaterThan(5)
    for (const file of files) {
      const code = codeTokens(readFileSync(join(dir, file), 'utf8'), file.endsWith('.svelte'))
      expect(code, file).not.toMatch(/ALLOWED_|allowlist|PROTECTED_IDS/i)
    }
  })
})
