import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

// Story 68.9 AC-12: no guard is a CM-only gate. The rules themselves are exercised symmetrically in
// apps/web/src/lib/security/guard-rules.test.ts (the same content under a PV path and under
// `src/lib/_cm/`, same verdict). This is the static twin: a guard (or the kit code that runs one)
// must hold no branch keyed on who wrote a file. Every occurrence of a CM-keyed token in the guard
// sources is listed below with its reason. The list is a TEST of this story's own rule, not an
// allowlist of CM behaviour: adding to it needs Nestor's sign-off, like any guard exception.
const ROOT = join(import.meta.dirname, '..')
const TOKENS = /_cm\b|materialized|fromCm|from CM|isCm\b/g

const GUARD_SOURCES = [
  'apps/web/src/lib/security/guard-rules.ts',
  'apps/web/src/lib/security/browser-storage-entries.ts',
  'apps/web/src/lib/security/tailwind-boundary.ts',
  'apps/web/src/lib/test/guard-root.ts',
  'apps/web/src/lib/test/route-exists.ts',
  'apps/web/src/lib/server/internal-api-consumers.ts',
  'apps/web/guards/form-guidance.ts',
  'apps/web/guards/monolithic-region.ts',
  'apps/web/guards/region-markup.ts',
  'apps/web/guards/svelte-files.ts',
  'packages/composition-kit/src/verify.ts',
  'packages/composition-kit/src/verify-cli.ts',
  'packages/composition-kit/src/verify-guards.ts',
  'packages/composition-kit/src/verify-run.ts',
  'packages/composition-kit/src/excluded-tests.ts',
]

/** file -> [token, count, reason]. */
const ALLOWED: Record<string, [string, number, string][]> = {
  // The composer's own source line is a constant PV's guard recognises (duplicated and pinned).
  'apps/web/src/lib/security/tailwind-boundary.ts': [
    ['_cm', 1, 'the composer @source line constant'],
  ],
  // `pv-verify --explain` maps composed paths back to pack sources; it changes no verdict.
  'packages/composition-kit/src/verify.ts': [['materialized', 1, 'the --explain source map']],
  // The exemption list a PV-duty guard (scope pv-originated-only) reads: the registry's own scope
  // rule, the only place CM-originated files are named for a guard.
  'packages/composition-kit/src/verify-guards.ts': [
    ['materialized', 1, 'files CM wrote, for pv-originated-only guards'],
  ],
}

/** Identifier and string-literal tokens of the code (comments and whitespace skipped). */
function codeTokens(source: string): string[] {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    true,
    ts.LanguageVariant.Standard,
    source
  )
  const tokens: string[] = []
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    const named =
      kind === ts.SyntaxKind.Identifier ||
      kind === ts.SyntaxKind.StringLiteral ||
      kind === ts.SyntaxKind.NoSubstitutionTemplateLiteral
    if (named) tokens.push(scanner.getTokenValue())
  }
  return tokens
}

export function cmKeyedTokens(source: string): Map<string, number> {
  const counts = new Map<string, number>()
  for (const token of codeTokens(source)) {
    for (const match of token.matchAll(TOKENS)) {
      counts.set(match[0], (counts.get(match[0]) ?? 0) + 1)
    }
  }
  return counts
}

describe('no guard is a CM-only gate (Story 68.9 AC-12)', () => {
  it('detects a contrived guard that skips CM files', () => {
    const patched = "for (const file of files) { if (file.path.includes('_cm')) continue }"
    expect(cmKeyedTokens(patched).get('_cm')).toBe(1)
    expect(cmKeyedTokens('if (isCm(file)) skip(); const lock = materialized')).toEqual(
      new Map([
        ['isCm', 1],
        ['materialized', 1],
      ])
    )
  })

  it.each(GUARD_SOURCES)('%s holds only the listed CM-keyed tokens', (file) => {
    const found = cmKeyedTokens(readFileSync(join(ROOT, file), 'utf8'))
    const allowed = new Map(
      (new Map(Object.entries(ALLOWED)).get(file) ?? []).map(([token, count]) => [token, count])
    )
    expect(Object.fromEntries(found)).toEqual(Object.fromEntries(allowed))
  })
})
