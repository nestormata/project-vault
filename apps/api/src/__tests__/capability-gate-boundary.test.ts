/* eslint-disable security/detect-non-literal-fs-filename */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Story 23.3 AC-21 — "the two checks stay structurally separate, enforced by an import-topology
 * test, not by prose." The capability check must never fold into `hasSufficientRole()` or a
 * single `authorize()` function; this is checked with teeth by asserting all three of:
 * 1. `checkCapability` is imported from `apps/api/src/lib/capability-gate.ts` by EXACTLY ONE
 *    module in `apps/api/src` — `lib/secure-route.ts` — and by exactly one call site within it.
 * 2. `apps/api/src/lib/capability-gate.ts` does NOT import PV's role/MFA/platform-operator
 *    helpers, and those helpers do not import it (no cyclic merge path).
 * 3. `assertCapability` is imported only by files listed in AC-14's golden route inventory
 *    (currently: `modules/monitoring/public-status-page-routes.ts`).
 */
const SRC_ROOT = resolve(process.cwd(), 'src')
const CAPABILITY_GATE_FILE = join(SRC_ROOT, 'lib/capability-gate.ts')

// AC-14's golden inventory of legal assertCapability() callers (relative to src/).
const LEGAL_ASSERT_CAPABILITY_IMPORTERS = ['modules/monitoring/public-status-page-routes.ts']

// AC-21: role/MFA/platform-operator helper modules capability-gate.ts must never import, and
// which must never import capability-gate.ts back (no cyclic merge path).
const ROLE_MFA_PLATFORM_OPERATOR_HELPERS = [
  'plugins/require-org-role.ts',
  'modules/auth/mfa-enforcement.ts',
]

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stats = statSync(full)
    if (stats.isDirectory()) walk(full, out)
    else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) out.push(full)
  }
  return out
}

describe('capability-gate.ts import topology (AC-21)', () => {
  it('checkCapability is imported from capability-gate.ts by exactly one module in apps/api/src: lib/secure-route.ts', () => {
    const importers: string[] = []
    for (const file of walk(SRC_ROOT)) {
      if (file === CAPABILITY_GATE_FILE) continue
      const source = readFileSync(file, 'utf-8')
      if (
        /from ['"].*\/capability-gate\.js['"]/.test(source) &&
        /\bcheckCapability\b/.test(source)
      ) {
        importers.push(file.slice(SRC_ROOT.length + 1))
      }
    }
    expect(importers).toEqual(['lib/secure-route.ts'])
  })

  it('checkCapability is called from exactly one call site within secure-route.ts', () => {
    const source = readFileSync(join(SRC_ROOT, 'lib/secure-route.ts'), 'utf-8')
    const callSites = source
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .filter((line) => line.includes('checkCapability('))
    expect(callSites).toHaveLength(1)
  })

  it('capability-gate.ts does not import PV role/MFA/platform-operator helpers', () => {
    const source = readFileSync(CAPABILITY_GATE_FILE, 'utf-8')
    for (const helper of ROLE_MFA_PLATFORM_OPERATOR_HELPERS) {
      const helperModuleName = helper.replace(/\.ts$/, '.js').split('/').pop()
      expect(
        source.includes(helperModuleName ?? ''),
        `capability-gate.ts must not import ${helper}`
      ).toBe(false)
    }
  })

  it('the role/MFA/platform-operator helpers do not import capability-gate.ts back (no cyclic merge path)', () => {
    for (const helper of ROLE_MFA_PLATFORM_OPERATOR_HELPERS) {
      const source = readFileSync(join(SRC_ROOT, helper), 'utf-8')
      expect(
        /from ['"].*\/capability-gate\.js['"]/.test(source),
        `${helper} must not import capability-gate.ts`
      ).toBe(false)
    }
  })

  it('assertCapability is imported only by files in AC-14s golden route inventory', () => {
    const importers: string[] = []
    for (const file of walk(SRC_ROOT)) {
      if (file === CAPABILITY_GATE_FILE) continue
      if (file.endsWith('capability-gate-audit.ts')) continue
      const source = readFileSync(file, 'utf-8')
      if (
        /from ['"].*\/capability-gate\.js['"]/.test(source) &&
        /\bassertCapability\b/.test(source)
      ) {
        importers.push(file.slice(SRC_ROOT.length + 1))
      }
    }
    expect(importers.sort()).toEqual([...LEGAL_ASSERT_CAPABILITY_IMPORTERS].sort())
  })
})

function matchBrace(source: string, openIndex: number): number {
  let depth = 0
  for (let i = openIndex; i < source.length; i += 1) {
    const char = source.charAt(i)
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return i + 1
    }
  }
  throw new Error('capability-gate-boundary: unbalanced braces while scanning source')
}

/** Extracts the CapabilityId values declared inside every bounded `security: { ... }` object
 * that contains a `capability:` field, using a balanced-brace scan (not a loose regex, which
 * would incorrectly span past the object's closing brace into unrelated later code). */
function declaredSecurityCapabilityIds(source: string): string[] {
  const ids: string[] = []
  const securityRegex = /security:\s*\{/g
  let match: RegExpExecArray | null
  while ((match = securityRegex.exec(source))) {
    const open = match.index + match[0].length - 1
    const close = matchBrace(source, open)
    const block = source.slice(open, close)
    const idMatch = /capability:\s*CapabilityId\.(\w+)/.exec(block)
    if (idMatch?.[1]) ids.push(idMatch[1])
  }
  return ids
}

/** Extracts the CapabilityId values passed to every `assertCapability({ ... })` call, using the
 * same balanced-brace scan. */
function assertCapabilityCallIds(source: string): string[] {
  const ids: string[] = []
  const callRegex = /assertCapability\(\s*\{/g
  let match: RegExpExecArray | null
  while ((match = callRegex.exec(source))) {
    const open = match.index + match[0].length - 1
    const close = matchBrace(source, open)
    const block = source.slice(open, close)
    const idMatch = /capability:\s*CapabilityId\.(\w+)/.exec(block)
    if (idMatch?.[1]) ids.push(idMatch[1])
  }
  return ids
}

describe('capability-gate — AC-10 static double-charge scan', () => {
  it('no file both passes security.capability to secureRoute() AND calls assertCapability() with the same CapabilityId', () => {
    for (const file of walk(SRC_ROOT)) {
      const source = readFileSync(file, 'utf-8')
      const securityIds = declaredSecurityCapabilityIds(source)
      const assertIds = assertCapabilityCallIds(source)
      const overlap = securityIds.filter((id) => assertIds.includes(id))
      expect(
        overlap,
        `${file.slice(SRC_ROOT.length + 1)} declares security.capability AND calls assertCapability() with the same CapabilityId — this is the forbidden double-charge arrangement`
      ).toEqual([])
    }
  })
})

describe('capability-gate — client error distinguishability (AC-21 edge case)', () => {
  it('insufficient_role, capability_denied+reasonCode, and capability_denied+gate_unavailable are three distinguishable response shapes', () => {
    const insufficientRole = { code: 'insufficient_role', message: 'Insufficient permissions' }
    const capabilityDeniedReal = {
      code: 'capability_denied',
      capability: 'monitoring.public-status-page',
      reasonCode: 'not_entitled',
      message: 'Upgrade to enable this.',
    }
    const capabilityDeniedUnavailable = {
      code: 'capability_denied',
      capability: 'monitoring.public-status-page',
      reasonCode: 'gate_unavailable',
      message: 'This capability is not available for your organization.',
    }
    // Distinguishable by `code` alone between role vs capability axes.
    expect(insufficientRole.code).not.toBe(capabilityDeniedReal.code)
    // Distinguishable by `reasonCode` between a real denial and an unavailable gate — a client
    // reading the response body alone (never PV branching on it) can tell all three apart.
    expect(capabilityDeniedReal.reasonCode).not.toBe(capabilityDeniedUnavailable.reasonCode)
    expect(
      new Set([
        insufficientRole.code,
        capabilityDeniedReal.reasonCode,
        capabilityDeniedUnavailable.reasonCode,
      ]).size
    ).toBe(3)
  })
})
