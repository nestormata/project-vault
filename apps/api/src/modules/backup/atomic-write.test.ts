/* eslint-disable security/detect-non-literal-fs-filename -- test exercises dynamic temp-dir paths */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { atomicFileWrite } from './atomic-write.js'

const TMP_PREFIX = 'atomic-write-test-'

describe('Story 9.6 D3.2: atomicFileWrite (extracted shared helper)', () => {
  let dir: string

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('writes then reads back the exact bytes', () => {
    dir = mkdtempSync(join(tmpdir(), TMP_PREFIX))
    const data = Buffer.from('hello atomic write')

    return atomicFileWrite(dir, 'file.bin', data).then(() => {
      const read = readFileSync(join(dir, 'file.bin'))
      expect(read.equals(data)).toBe(true)
    })
  })

  it('never leaves a partially written file under its final name (atomic tmp+rename)', async () => {
    dir = mkdtempSync(join(tmpdir(), TMP_PREFIX))
    await atomicFileWrite(dir, 'final.bin', Buffer.from('final content'))

    const entries = readdirSync(dir)
    expect(entries).toEqual(['final.bin'])
    expect(entries.some((e) => e.startsWith('.tmp-'))).toBe(false)
  })

  it('creates the destination directory if it does not exist yet', async () => {
    dir = join(mkdtempSync(join(tmpdir(), TMP_PREFIX)), 'nested', 'path')
    await atomicFileWrite(dir, 'nested.bin', Buffer.from('x'))

    expect(readdirSync(dir)).toContain('nested.bin')
  })
})
