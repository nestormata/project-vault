import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readComponentIndex, replacementNotes } from './component-index.js'
import type { ReplacementRecord } from './overlay.js'

const A_TS = 'src/lib/a.ts'
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function hostWith(index?: unknown): string {
  const root = mkdtempSync(join(tmpdir(), 'kit-component-index-'))
  roots.push(root)
  mkdirSync(join(root, 'manifests'))
  if (index !== undefined) {
    writeFileSync(
      join(root, 'manifests', 'component-index.json'),
      typeof index === 'string' ? index : JSON.stringify(index)
    )
  }
  return root
}

function record(target: string, hostPath: string): ReplacementRecord {
  return {
    target,
    with: 'r/x',
    hostSha256: 'a',
    cmSha256: 'b',
    story: null,
    hostVersion: '1.5.0',
    hostPath,
  }
}

const SEARCH = record(
  '$lib/components/shell/GlobalSearch.svelte',
  'src/lib/components/shell/GlobalSearch.svelte'
)

describe('readComponentIndex (a signal, never a gate)', () => {
  it('reads path and stability, ignoring every other field', () => {
    const index = readComponentIndex(
      hostWith({
        schemaVersion: 1,
        extra: 1,
        components: [
          { path: A_TS, stability: 'stable', hash: 'h' },
          { path: 'src/lib/b.ts', stability: 'unmarked', hash: 'h' },
        ],
      })
    )
    expect(index.stability).toEqual(
      new Map([
        [A_TS, 'stable'],
        ['src/lib/b.ts', 'unmarked'],
      ])
    )
    expect(index.notes).toEqual([])
  })

  it('is absent (no entries, no notes) when the host ships none', () => {
    expect(readComponentIndex(hostWith())).toEqual({ notes: [] })
  })

  it('ignores a malformed or newer index with a note instead of failing', () => {
    for (const bad of ['{{', { schemaVersion: 2, components: [] }, { schemaVersion: 1 }]) {
      const index = readComponentIndex(hostWith(bad))
      expect(index.stability).toBeUndefined()
      expect(index.notes).toEqual([expect.stringContaining('component-index.json')])
    }
  })
})

describe('replacementNotes (AC-9: informational, never a failure)', () => {
  const stability = new Map([['src/lib/components/shell/GlobalSearch.svelte', 'stable']])

  it('notes each replacement with its stability signal', () => {
    expect(replacementNotes([SEARCH], stability)).toEqual([
      'replacement $lib/components/shell/GlobalSearch.svelte: stable',
    ])
    expect(replacementNotes([SEARCH], new Map([[SEARCH.hostPath, 'unmarked']]))).toEqual([
      'replacement $lib/components/shell/GlobalSearch.svelte: unmarked',
    ])
  })

  it('notes a target that is not in the index', () => {
    expect(replacementNotes([SEARCH], new Map())).toEqual([
      'replacement $lib/components/shell/GlobalSearch.svelte: not in manifests/component-index.json (no stability signal)',
    ])
  })

  it('says nothing about stability when the host ships no index', () => {
    expect(replacementNotes([SEARCH], undefined)).toEqual([])
  })

  it('flags a server-side module so a lock reviewer sees it, with or without an index', () => {
    const auth = record('$lib/server/auth', 'src/lib/server/auth.ts')
    const api = record('$lib/api/audit.ts', 'src/lib/api/audit.ts')
    expect(replacementNotes([auth, api], undefined)).toEqual([
      'replacement $lib/api/audit.ts: server-side module',
      'replacement $lib/server/auth: server-side module',
    ])
    expect(replacementNotes([auth], new Map([[auth.hostPath, 'stable']]))).toEqual([
      'replacement $lib/server/auth: server-side module',
      'replacement $lib/server/auth: stable',
    ])
  })

  it('is sorted by code unit, so the lock stays deterministic', () => {
    const notes = replacementNotes([SEARCH, record('$lib/a.ts', A_TS)], new Map())
    expect(notes).toEqual([...notes].sort())
  })
})
