/* eslint-disable security/detect-non-literal-fs-filename */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { describe, expect, it } from 'vitest'

const API_SRC_ROOT = resolve(process.cwd(), 'src')
const WEB_SRC_ROOT = resolve(process.cwd(), '../../apps/web/src')

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stats = statSync(full)
    if (stats.isDirectory()) walk(full, out)
    else if (entry.endsWith('.ts') || entry.endsWith('.svelte')) out.push(full)
  }
  return out
}

/**
 * Story 23.3 AC-13 — there is deliberately NO enforcement-bypass switch. This grep is the
 * name-based prevention half of the check (the behavioral proof is AC-11/AC-12's fail-closed
 * tests in capability-gate.test.ts, which is the other half — neither is presented as doing the
 * other's job).
 */
describe('capability gate — no break-glass switch exists (AC-13)', () => {
  it('the literal string VAULT_CAPABILITY_GATE_FAILURE_MODE appears nowhere in apps/api/src', () => {
    for (const file of walk(API_SRC_ROOT)) {
      if (file.endsWith('capability-gate-lint-style.test.ts')) continue // this file names the string it checks for
      const source = readFileSync(file, 'utf-8')
      expect(source.includes('VAULT_CAPABILITY_GATE_FAILURE_MODE')).toBe(false)
    }
  })

  it('the identifier failureMode does not appear in capability-gate.ts', () => {
    const source = readFileSync(join(API_SRC_ROOT, 'lib/capability-gate.ts'), 'utf-8')
    expect(source.includes('failureMode')).toBe(false)
  })
})

/**
 * Story 23.3 AC-4 — `reasonCode` is opaque to PV: no `switch`/`if`/comparison/lookup over it may
 * exist anywhere in apps/api or apps/web.
 */
describe('capability gate — reasonCode is never branched on (AC-4)', () => {
  const forbiddenPatterns = [/reasonCode\s*===/, /reasonCode\.includes/, /reasonCode\.startsWith/]

  it('no forbidden reasonCode comparison exists in apps/api/src', () => {
    for (const file of walk(API_SRC_ROOT)) {
      const source = readFileSync(file, 'utf-8')
      for (const pattern of forbiddenPatterns) {
        expect(pattern.test(source)).toBe(false)
      }
    }
  })

  it('no forbidden reasonCode comparison exists in apps/web/src', () => {
    for (const file of walk(WEB_SRC_ROOT)) {
      const source = readFileSync(file, 'utf-8')
      for (const pattern of forbiddenPatterns) {
        expect(pattern.test(source)).toBe(false)
      }
    }
  })
})

/** Story 23.3 AC-8 — the test-only reset helper is never referenced from production code. */
describe('capability gate — __resetCapabilityGateForTests is test-only (AC-8)', () => {
  it('no non-test file in apps/api/src references __resetCapabilityGateForTests', () => {
    for (const file of walk(API_SRC_ROOT)) {
      if (file.endsWith('.test.ts')) continue
      if (file.endsWith('capability-gate.ts')) continue // the definition site
      const source = readFileSync(file, 'utf-8')
      expect(source.includes('__resetCapabilityGateForTests')).toBe(false)
    }
  })
})
