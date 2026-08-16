import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import { describe, expect, it } from 'vitest'

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Story 23.2 AC-15: "write ... the AC-15 warning block that the in-memory jti set proves
 * nothing across workers/instances ... test that the warning text is present" — both in the
 * README (the manual-QA-facing document) and in a source header comment (the code-reading-facing
 * document), so neither surface can silently lose the warning independently of the other. */
describe('AC-15 warning block presence', () => {
  it('is present in README.md', () => {
    // PACKAGE_ROOT is a fixed, module-relative constant — not external input.
    const readme = readFileSync(resolve(PACKAGE_ROOT, 'README.md'), 'utf-8')
    expect(readme).toContain('proves nothing in production')
    expect(readme).toContain('DB-backed atomic conditional write')
  })

  it('is present in the src/index.ts source header comment on burnedJti', () => {
    const source = readFileSync(resolve(PACKAGE_ROOT, 'src/index.ts'), 'utf-8')
    expect(source).toContain('proves nothing')
    expect(source).toContain('across workers or restarts')
    expect(source).toContain('DB-backed atomic conditional write')
  })
})
