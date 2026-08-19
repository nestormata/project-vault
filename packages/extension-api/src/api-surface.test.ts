import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { assertSurfaceSnapshotIsFresh, validateSinceIndex } from '../tests/api-surface.js'

describe('extension API public type surface snapshot', () => {
  const packageRoot = fileURLToPath(new URL('..', import.meta.url))

  it('runs from the package test task and matches source, including nested members', () => {
    expect(assertSurfaceSnapshotIsFresh(packageRoot)).toEqual({ ok: true })
  })

  it('rejects a snapshot with a missing since annotation', () => {
    expect(validateSinceIndex('## export Foo\n- member: value\n').join('\n')).toContain(
      'missing since'
    )
  })

  it('rejects a since version newer than the package API version', () => {
    expect(validateSinceIndex('## export Foo\n- since: 9.0.0\n').join('\n')).toContain('exceeds')
  })
})
