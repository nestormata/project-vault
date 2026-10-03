import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { KIT_VERSION } from './version.js'

describe('KIT_VERSION', () => {
  it('equals the version in package.json', () => {
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8')
    ) as { version: string }
    expect(KIT_VERSION).toBe(manifest.version)
  })
})
