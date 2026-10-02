import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  SHARED_SOURCE_MARKER,
  VENDORED_SHARED_SOURCE_GLOB,
  rewriteSharedSource,
} from '../config/app-css-source.ts'

const MONOREPO_SHARED_SOURCE = '@source "../../../packages/shared/src/**/*.ts";'

describe('Tailwind source detection', () => {
  it('limits class scanning to application and shared source files', async () => {
    const css = await readFile(join(process.cwd(), 'src/app.css'), 'utf8')

    expect(css).toContain('@import "tailwindcss" source(none);')
    expect(css).toContain('@source "./**/*.{svelte,ts}";')
    expect(css).toContain(MONOREPO_SHARED_SOURCE)
  })

  // Story 68.2 AC-3: the packed web-host rewrites the marked shared @source line to the vendored
  // copy, and story 68-3's composer rewrites the same marked line again.
  it('marks the shared @source line so the pack (and later the composer) can rewrite it', async () => {
    const css = await readFile(join(process.cwd(), 'src/app.css'), 'utf8')
    const lines = css.split('\n')
    const marker = lines.findIndex((line) => line.trim() === SHARED_SOURCE_MARKER)

    expect(marker).toBeGreaterThanOrEqual(0)
    expect(lines.at(marker + 1)).toBe(MONOREPO_SHARED_SOURCE)

    const packed = rewriteSharedSource(css, VENDORED_SHARED_SOURCE_GLOB)
    expect(packed).toContain('@source "../vendor/shared/src/**/*.ts";')
    expect(packed).not.toContain(MONOREPO_SHARED_SOURCE)
    expect(packed).toContain('@source "./**/*.{svelte,ts}";')
    expect(rewriteSharedSource(packed, '../elsewhere/**/*.ts')).toContain(
      '@source "../elsewhere/**/*.ts";'
    )
  })

  it('refuses to rewrite when the marker or its @source line is missing or repeated', () => {
    expect(() => rewriteSharedSource('@source "x";', VENDORED_SHARED_SOURCE_GLOB)).toThrow(/marker/)
    expect(() =>
      rewriteSharedSource(`${SHARED_SOURCE_MARKER}\n@theme {}`, VENDORED_SHARED_SOURCE_GLOB)
    ).toThrow(/@source/)
    const twice = `${SHARED_SOURCE_MARKER}\n@source "a";\n${SHARED_SOURCE_MARKER}\n@source "b";`
    expect(() => rewriteSharedSource(twice, VENDORED_SHARED_SOURCE_GLOB)).toThrow(/exactly once/)
  })
})
