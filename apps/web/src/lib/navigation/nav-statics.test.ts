// Story 68.7 AC-7/AC-14 and design rule 3: no shared mutable state in the nav code, one code path
// for PV's build and a composed build, and a deep-frozen shared delta.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'

const NAV_DIR = import.meta.dirname
const SRC_DIR = join(NAV_DIR, '..', '..')

function sources(dir: string, pattern: RegExp): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter(
      (file) => pattern.test(file) && !file.endsWith('.test.ts') && !file.includes('paraglide')
    )
    .map((file) => join(dir, file))
}

describe('statics (Story 68.7 AC-14, design rule 3)', () => {
  it('no module-level `let` in apps/web/src/lib/navigation', () => {
    const files = sources(NAV_DIR, /\.ts$/)
    expect(files.length).toBeGreaterThan(8)
    for (const file of files) {
      const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest)
      const lets = source.statements.filter(
        (statement) =>
          ts.isVariableStatement(statement) &&
          (statement.declarationList.flags & ts.NodeFlags.Let) !== 0
      )
      expect(lets, file).toEqual([])
    }
  })

  it('nothing in apps/web/src branches on a composed build', () => {
    for (const file of sources(SRC_DIR, /\.(ts|svelte)$/)) {
      const code = readFileSync(file, 'utf8')
      expect(code, file).not.toMatch(/\bif\s*\(\s*!?\s*(?:is)?composed\b/i)
      expect(code, file).not.toMatch(/import\.meta\.env\.\w*COMPOSED/)
    }
  })

  it('builders read no clock, randomness, window or storage', () => {
    for (const file of sources(join(NAV_DIR, 'surfaces'), /\.ts$/)) {
      const code = readFileSync(file, 'utf8')
      expect(code, file).not.toMatch(/\b(Date|Math\.random|window|localStorage|sessionStorage)\b/)
    }
  })
})

describe('the shared delta is deep-frozen at first use (Story 68.7 AC-7)', () => {
  it('an attempted mutation throws and the next render is unchanged', async () => {
    vi.resetModules()
    vi.doMock('virtual:pv-nav', () => ({
      default: { primary: [{ op: 'hide', id: 'primary.health', extra: { nested: true } }] },
    }))
    const { activeDelta } =
      await vi.importActual<typeof import('./active-delta.js')>('./active-delta.js')
    const ops = activeDelta.primary ?? []
    expect(Object.isFrozen(activeDelta)).toBe(true)
    expect(Object.isFrozen(ops)).toBe(true)
    expect(Object.isFrozen(ops[0])).toBe(true)
    expect(() => {
      ;(ops as unknown as unknown[]).push({ op: 'remove', id: 'primary.settings' })
    }).toThrow(TypeError)
    expect(() => {
      Object.assign(ops[0] ?? {}, { id: 'primary.settings' })
    }).toThrow(TypeError)
    const { renderSurface } =
      await vi.importActual<typeof import('./build-surface.js')>('./build-surface.js')
    const ctx = {
      pathname: '/',
      user: { isPlatformOperator: false, orgRole: 'owner' },
      hasUiPanelExtension: false,
    }
    const first = renderSurface('primary', ctx, { delta: activeDelta, strict: true }).map(
      (n) => n.id
    )
    expect(first).not.toContain('primary.health')
    expect(first).toContain('primary.settings')
    vi.doUnmock('virtual:pv-nav')
  })
})
