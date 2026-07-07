import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readPackageVersion } from './package-version.js'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('readPackageVersion', () => {
  it('reads the version field from the given package.json path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'package-version-test-'))
    tempDirs.push(dir)
    const pkgPath = join(dir, 'package.json')
    writeFileSync(pkgPath, JSON.stringify({ name: 'fixture', version: '9.9.9' }))

    expect(readPackageVersion(pkgPath)).toBe('9.9.9')
  })

  it('reflects a version bump with zero other code changes (AC-19)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'package-version-test-'))
    tempDirs.push(dir)
    const pkgPath = join(dir, 'package.json')
    writeFileSync(pkgPath, JSON.stringify({ name: 'fixture', version: '0.1.0' }))

    expect(readPackageVersion(pkgPath)).toBe('0.1.0')
  })
})
