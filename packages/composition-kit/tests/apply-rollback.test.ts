import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { swapIn } from '../src/apply.js'
import { OWNED_DIRECTORIES } from '../src/sources.js'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('swapIn rollback', () => {
  it('restores every previous directory and deletes none that it never moved', () => {
    const root = mkdtempSync(join(tmpdir(), 'pv-swap-'))
    roots.push(root)
    const app = join(root, 'app')
    const stage = join(root, 'stage')
    for (const owned of OWNED_DIRECTORIES) {
      mkdirSync(join(app, owned), { recursive: true })
      writeFileSync(join(app, owned, 'keep.txt'), `old ${owned}`)
    }
    // The staged tree lacks its first directory, so the swap fails part-way.
    mkdirSync(join(stage, 'new'), { recursive: true })
    for (const owned of OWNED_DIRECTORIES.slice(1)) mkdirSync(join(stage, 'new', owned))
    expect(() => swapIn(app, stage)).toThrow()
    for (const owned of OWNED_DIRECTORIES) {
      expect(existsSync(join(app, owned, 'keep.txt'))).toBe(true)
      expect(readFileSync(join(app, owned, 'keep.txt'), 'utf8')).toBe(`old ${owned}`)
    }
  })
})
