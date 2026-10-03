import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runGuard, scanFormGuidanceTree } from '../apps/web/guards/form-guidance'
import { scanFormGuidance, scanWebFormGuidance } from './check-form-guidance'
import { toRepoPath, walkFiles } from './lib/scan-utils'

const fixture = 'fixture.svelte'

describe('check-form-guidance', () => {
  it('reports a visible control without a visible description relationship', () => {
    const findings = scanFormGuidance(
      '<label for="name">Name</label>\n<input id="name" name="name" />',
      fixture
    )

    expect(findings).toEqual([
      expect.objectContaining({
        file: 'fixture.svelte',
        line: 2,
        kind: 'missing-description',
        control: 'input#name',
      }),
    ])
  })

  it('requires every user-facing control type, including checkbox, radio, select, and textarea', () => {
    const source = [
      '<input type="checkbox" id="cacheable" />',
      '<input type="radio" id="role-admin" name="role" />',
      '<select id="role"></select>',
      '<textarea id="notes"></textarea>',
    ].join('\n')

    expect(scanFormGuidance(source, fixture)).toHaveLength(4)
  })

  it('accepts a visible description referenced by aria-describedby', () => {
    const source =
      '<input id="name" aria-describedby="name-help" />\n<p id="name-help">Used in the project list.</p>'

    expect(scanFormGuidance(source, fixture)).toEqual([])
  })

  it('does not report hidden inputs or option-only markup', () => {
    const source =
      '<input type="hidden" name="csrf" value={token} />\n<option value="admin">Admin</option>'

    expect(scanFormGuidance(source, fixture)).toEqual([])
  })

  it('reports missing referenced descriptions and duplicate description ids', () => {
    const source = [
      '<input id="one" aria-describedby="missing" />',
      '<input id="two" aria-describedby="help" />',
      '<p id="help">First explanation.</p>',
      '<p id="help">Second explanation.</p>',
    ].join('\n')

    expect(scanFormGuidance(source, fixture)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'missing-description-target', line: 1 }),
        expect.objectContaining({ kind: 'duplicate-description-id', line: 4 }),
      ])
    )
  })
})

// Story 68.9 AC-8: the shipped scanner runs over a composed app root with the same rules.
describe('scanFormGuidanceTree over a composed tree', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  function composed(files: Record<string, string>): string {
    const root = mkdtempSync(join(tmpdir(), 'pv-form-guidance-'))
    roots.push(root)
    for (const [rel, content] of Object.entries(files)) {
      mkdirSync(join(root, rel, '..'), { recursive: true })
      writeFileSync(join(root, rel), content)
    }
    return root
  }

  it('reports a CM control without a description, with the composed path', () => {
    const root = composed({ 'src/lib/_cm/Invite.svelte': '<input id="email" />' })
    expect(scanFormGuidanceTree(join(root, 'src'))).toEqual([
      expect.objectContaining({ file: 'src/lib/_cm/Invite.svelte', kind: 'missing-description' }),
    ])
  })

  it('reports a missing target and a duplicate id in CM code like in PV code', () => {
    const root = composed({
      'src/lib/_cm/A.svelte': '<input id="a" aria-describedby="gone" />',
      'src/lib/_cm/B.svelte':
        '<input id="b" aria-describedby="hint" /><p id="hint">x</p><p id="hint">y</p>',
    })
    const kinds = scanFormGuidanceTree(join(root, 'src')).map((finding) => finding.kind)
    expect(kinds).toEqual(['missing-description-target', 'duplicate-description-id'])
  })

  it('skips node_modules and dangling symlinks, follows live ones', () => {
    const root = composed({
      'src/node_modules/x/Bad.svelte': '<input id="x" />',
      'elsewhere/Linked.svelte': '<input id="l" />',
    })
    symlinkSync(join(root, 'elsewhere/Linked.svelte'), join(root, 'src/Linked.svelte'))
    symlinkSync(join(root, 'nowhere.svelte'), join(root, 'src/Dangling.svelte'))
    expect(scanFormGuidanceTree(join(root, 'src')).map((finding) => finding.file)).toEqual([
      'src/Linked.svelte',
    ])
  })

  it('walks the same files as the repository walker', () => {
    const root = composed({
      'src/a/One.svelte': '<input id="1" />',
      'src/a/b/Two.svelte': '<input id="2" />',
      'src/node_modules/p/Three.svelte': '<input id="3" />',
      'src/Plain.ts': 'export {}',
    })
    symlinkSync(join(root, 'src/a'), join(root, 'src/Linked'))
    const walked = walkFiles(join(root, 'src'), (file) => file.endsWith('.svelte')).map((file) =>
      toRepoPath(root, file)
    )
    const scanned = scanFormGuidanceTree(join(root, 'src')).map((finding) => finding.file)
    expect([...new Set(scanned)].sort()).toEqual(walked.sort())
  })

  it('exposes the script-guard contract: findings with composed paths and the rule in the message', () => {
    const root = composed({ 'src/lib/_cm/Invite.svelte': '<input id="email" />' })
    expect(runGuard(root)).toEqual([
      {
        file: 'src/lib/_cm/Invite.svelte',
        message: expect.stringContaining('missing-description src/lib/_cm/Invite.svelte:1'),
      },
    ])
    expect(runGuard(composed({ 'src/ok.svelte': '<p>x</p>' }))).toEqual([])
  })

  it('finds nothing in PV itself', () => {
    expect(scanWebFormGuidance(resolve(import.meta.dirname, '..'))).toEqual([])
  })
})
