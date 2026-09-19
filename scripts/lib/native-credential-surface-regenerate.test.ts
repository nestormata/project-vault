import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import { describe, expect, it } from 'vitest'
import { regenerateManifest } from './native-credential-surface-regenerate.js'
import type { SurfaceHit, SurfaceManifestEntry } from './native-credential-surface-scan.js'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SCRIPT_DIR, '../..')
const MANIFEST_PATH = resolve(REPO_ROOT, 'apps/api/src/modules/auth/native-credential-surface.json')

const AC = 'test-ac'
const P1 = 'P1'
const P2 = 'P2'
const P5 = 'P5'
const SEE_COMMENT_CONTEXT = '(see comment context)'
const VERIFY_A_B = 'verifyUserPassword(a, b)'
const INSERT_USERS = 'insert(users)'

function entry(
  overrides: Partial<SurfaceManifestEntry> &
    Pick<SurfaceManifestEntry, 'path' | 'line' | 'predicate'>
): SurfaceManifestEntry {
  return {
    symbol: '',
    classification: 'bespoke',
    ac: AC,
    ...overrides,
  }
}

function hit(
  overrides: Partial<SurfaceHit> & Pick<SurfaceHit, 'path' | 'line' | 'predicate'>
): SurfaceHit {
  return { text: '', ...overrides }
}

describe('regenerateManifest (Story 40.2)', () => {
  it('re-points a manifest entry to its new line via exact symbol match (pure line-shift)', () => {
    const manifest = [entry({ path: 'a.ts', line: 5, predicate: P1, symbol: VERIFY_A_B })]
    const hits = [hit({ path: 'a.ts', line: 9, predicate: P1, text: VERIFY_A_B })]

    const result = regenerateManifest(REPO_ROOT, manifest, hits)

    expect(result.manifest.at(0)?.line).toBe(9)
    expect(result.changes).toEqual([{ path: 'a.ts', predicate: P1, oldLine: 5, newLine: 9 }])
    expect(result.unresolvedGroupCount).toBe(0)
  })

  it('uses ordinal fallback for entries with no literal symbol match (e.g. "(see comment context)")', () => {
    const manifest = [
      entry({ path: 'b.ts', line: 3, predicate: P2, symbol: SEE_COMMENT_CONTEXT }),
      entry({ path: 'b.ts', line: 10, predicate: P2, symbol: SEE_COMMENT_CONTEXT }),
    ]
    const hits = [
      hit({ path: 'b.ts', line: 6, predicate: P2, text: 'passwordHash: fields.passwordHash,' }),
      hit({ path: 'b.ts', line: 14, predicate: P2, text: 'passwordHash: other,' }),
    ]

    const result = regenerateManifest(REPO_ROOT, manifest, hits)

    expect(result.manifest.map((e) => e.line)).toEqual([6, 14])
    expect(result.changes).toEqual([
      { path: 'b.ts', predicate: P2, oldLine: 3, newLine: 6 },
      { path: 'b.ts', predicate: P2, oldLine: 10, newLine: 14 },
    ])
  })

  it('leaves a group-size mismatch (genuinely new/removed hit) completely untouched', () => {
    const manifest = [
      entry({ path: 'c.ts', line: 5, predicate: P1, symbol: 'verifyUserPassword(a)' }),
    ]
    const hits = [
      hit({ path: 'c.ts', line: 5, predicate: P1, text: 'verifyUserPassword(a)' }),
      hit({ path: 'c.ts', line: 20, predicate: P1, text: 'verifyUserPassword(b)' }),
    ]

    const result = regenerateManifest(REPO_ROOT, manifest, hits)

    expect(result.manifest).toEqual(manifest)
    expect(result.changes).toEqual([])
    expect(result.unresolvedGroupCount).toBe(1)
  })

  it('is idempotent: running twice with no source changes yields zero further changes', () => {
    const manifest = [entry({ path: 'a.ts', line: 5, predicate: P1, symbol: VERIFY_A_B })]
    const hits = [hit({ path: 'a.ts', line: 9, predicate: P1, text: VERIFY_A_B })]

    const first = regenerateManifest(REPO_ROOT, manifest, hits)
    const second = regenerateManifest(REPO_ROOT, first.manifest, hits)

    expect(second.changes).toEqual([])
    expect(second.manifest).toEqual(first.manifest)
  })

  it('produces byte-identical field sets for an already-correct manifest+tree (formatting fidelity)', () => {
    const manifest = [entry({ path: 'a.ts', line: 9, predicate: P1, symbol: VERIFY_A_B })]
    const hits = [hit({ path: 'a.ts', line: 9, predicate: P1, text: VERIFY_A_B })]

    const result = regenerateManifest(REPO_ROOT, manifest, hits)

    expect(result.manifest).toEqual(manifest)
    expect(result.changes).toEqual([])
  })

  it('excludes a touched group from the write when its candidate manifest does not self-verify clean (AC-11)', () => {
    // The group-size guard alone passes (1 entry, 1 hit) and the pairing algorithm produces a
    // line-shift mapping, but this entry already carries an invalid field (missing `ac`) that
    // makes the resulting CANDIDATE manifest fail `checkNativeCredentialSurface`'s own diff for
    // this group. AC-11 requires re-running that diff before writing and excluding any group that
    // doesn't come back clean — this proves the self-verify pass is real (reuses the actual check
    // function), not merely a restatement of the group-size guard.
    const manifest = [
      entry({
        path: 'd.ts',
        line: 5,
        predicate: P1,
        symbol: 'verifyUserPassword(oldArg)',
        ac: '',
      }),
    ]
    const hits = [
      hit({ path: 'd.ts', line: 40, predicate: P1, text: 'verifyUserPassword(oldArg)' }),
    ]

    const result = regenerateManifest(REPO_ROOT, manifest, hits)

    expect(result.manifest).toEqual(manifest)
    expect(result.changes).toEqual([])
    expect(result.unresolvedGroupCount).toBe(1)
  })

  it('never moves an entry that is already on a real hit line, even if its symbol is stale (identity precedes symbol-match)', () => {
    // Both entries already sit on real, distinct hits for this group (no drift at all — the
    // group already passes the plain check-only path). Entry A's `symbol` field happens to be
    // stale and textually matches entry B's hit instead of its own. A pure symbol-match-first
    // algorithm would "fix" this by swapping A and B's lines, corrupting two already-correct
    // entries. Discovered via this story's real-repo manual `--write` verification run.
    const manifest = [
      entry({
        path: 'f.ts',
        line: 10,
        predicate: P2,
        symbol: 'passwordHash: sentinelPasswordHash,',
      }),
      entry({ path: 'f.ts', line: 15, predicate: P2, symbol: SEE_COMMENT_CONTEXT }),
    ]
    const hits = [
      hit({ path: 'f.ts', line: 10, predicate: P2, text: 'const sentinelPasswordHash = x' }),
      hit({ path: 'f.ts', line: 15, predicate: P2, text: 'passwordHash: sentinelPasswordHash,' }),
    ]

    const result = regenerateManifest(REPO_ROOT, manifest, hits)

    expect(result.manifest.map((e) => e.line)).toEqual([10, 15])
    expect(result.changes).toEqual([])
    expect(result.unresolvedGroupCount).toBe(0)
  })

  it('claims duplicate-text hits deterministically by ascending line (AC-12)', () => {
    const manifest = [
      entry({ path: 'e.ts', line: 3, predicate: P5, symbol: INSERT_USERS }),
      entry({ path: 'e.ts', line: 30, predicate: P5, symbol: INSERT_USERS }),
    ]
    const hits = [
      hit({ path: 'e.ts', line: 8, predicate: P5, text: INSERT_USERS }),
      hit({ path: 'e.ts', line: 50, predicate: P5, text: INSERT_USERS }),
    ]

    const result1 = regenerateManifest(REPO_ROOT, manifest, hits)
    const result2 = regenerateManifest(REPO_ROOT, manifest, hits)

    expect(result1.manifest.map((e) => e.line)).toEqual([8, 50])
    expect(result2.manifest.map((e) => e.line)).toEqual([8, 50])
  })

  it('the real checked-in manifest already stores same-group entries in ascending-line order', () => {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8')) as SurfaceManifestEntry[]
    const groups = new Map<string, number[]>()
    for (const e of manifest) {
      const key = `${e.path}:::${e.predicate}`
      const lines = groups.get(key) ?? []
      lines.push(e.line)
      groups.set(key, lines)
    }
    for (const [key, lines] of groups) {
      const sorted = [...lines].sort((a, b) => a - b)
      expect(lines, `group ${key} is not in ascending-line order`).toEqual(sorted)
    }
  })
})
