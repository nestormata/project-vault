import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Story 43.6 AC-6 — the version check is CLI-entry-only: outside the version-check modules
 * themselves, only `cli.ts` may import them. The Epic 50 seams (`inject-and-run.ts`,
 * `write-env-file.ts`, `fetch-secrets.ts`) never do.
 */
const SRC_DIR = fileURLToPath(new URL('.', import.meta.url))
const VERSION_CHECK_IMPORT = /from '\.\/version-check[a-z-]*\.js'/

function productionSources(): string[] {
  return readdirSync(SRC_DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
}

describe('version-check import boundary (AC-6)', () => {
  it('only cli.ts (and the version-check modules themselves) import version-check*.ts', () => {
    const importers = productionSources().filter(
      (file) =>
        !file.startsWith('version-check') &&
        VERSION_CHECK_IMPORT.test(readFileSync(`${SRC_DIR}${file}`, 'utf8'))
    )
    expect(importers).toEqual(['cli.ts'])
  })

  it.each(['inject-and-run.ts', 'write-env-file.ts', 'fetch-secrets.ts'])(
    'the Epic 50 seam %s has no version-check import',
    (seam) => {
      expect(readFileSync(`${SRC_DIR}${seam}`, 'utf8')).not.toMatch(/version-check|build-info/)
    }
  )
})
