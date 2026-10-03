import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// ADR 0007 guardrail 8 / Story 68.3 AC-7: the kit has NO allowlist, NO required path prefix and NO
// limit on what a pack may override, remove, replace or inject. The behavioural proof is in
// compose.test.ts ("nothing is an allowlist"); this test is the structural twin: it fails if a
// gate-shaped identifier or prefix check appears in the kit's source.

const FORBIDDEN: { pattern: RegExp; reason: string }[] = [
  {
    pattern: /allowedPaths|allowlist|overridablePaths|replaceablePaths|allowedTargets/i,
    reason: 'an allowlist of overridable paths',
  },
  { pattern: /startsWith\(['"`]src\/routes/, reason: 'a route-prefix gate' },
  // Story 68.5 AC-13: M4 replaces ANY module under src/lib; a prefix gate on it would narrow M4.
  {
    pattern: /startsWith\(['"`](?:src\/lib|\$lib)\/(?:components|api)/,
    // `$lib/server/` is deliberately not listed: contributions.ts uses it to PLACE a replacement
    // under server/_cm (the server-only guard), which gates nothing.
    reason: 'a replacement-target prefix gate',
  },
  // `@pv-stable` and component-index.json are SIGNALS: nothing may refuse on stability.
  {
    pattern: /stability[^\n]*(?:throw |problems\.push|\.error\(|refus)/i,
    reason: 'a refusal based on stability',
  },
  {
    pattern: /(?:denylist|blocklist|forbiddenPaths|protectedFiles)/i,
    reason: 'a deny list of paths',
  },
]

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : []
  })
}

describe('the composer never narrows M1-M7 (Story 68.3 AC-7)', () => {
  const files = sourceFiles(join(import.meta.dirname, '..', 'src'))

  it('scans the kit source', () => {
    expect(files.length).toBeGreaterThan(10)
  })

  it.each(FORBIDDEN)('has no $reason', ({ pattern }) => {
    for (const file of files) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(pattern)
    }
  })
})
