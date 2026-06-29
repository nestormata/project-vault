import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('Tailwind source detection', () => {
  it('limits class scanning to application and shared source files', async () => {
    const css = await readFile(join(process.cwd(), 'src/app.css'), 'utf8')

    expect(css).toContain('@import "tailwindcss" source(none);')
    expect(css).toContain('@source "./**/*.{svelte,ts}";')
    expect(css).toContain('@source "../../../packages/shared/src/**/*.ts";')
  })
})
