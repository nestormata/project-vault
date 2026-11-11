import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { m } from '$lib/paraglide/messages.js'
import { overlayableMessage } from '$lib/test/overlayable-messages.js'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/svelte'
import AuthBrandHeader from './AuthBrandHeader.svelte'

afterEach(() => cleanup())

describe('AuthBrandHeader.svelte', () => {
  // Story 68.1 AC-5: the logo uses asset() (static/ file API) instead of resolve(); with no
  // paths.base/paths.assets configured the rendered src is unchanged.
  it('renders the logo mark from the static asset path and the brand name', () => {
    const { container } = render(AuthBrandHeader)

    expect(container.querySelector('img')?.getAttribute('src')).toBe('/logo-mark.png')
    expect(screen.getByText(m.brand_name())).toBeTruthy()
  })

  // Story 72.23 / 72.19: read the message, do not write the default sentence.
  it('renders the tagline from the shell_brand_tagline message', () => {
    render(AuthBrandHeader)

    expect(screen.getByText(m.shell_brand_tagline())).toBeTruthy()
  })

  it('reads the tagline from the shell_brand_tagline message in every locale', () => {
    expect(m.shell_brand_tagline()).not.toBe('')
    expect(overlayableMessage('shell_brand_tagline', 'es')).not.toBe('')
  })

  it('does not hard-code the default tagline sentence', () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'AuthBrandHeader.svelte'),
      'utf8'
    )
    expect(source).toContain('m.shell_brand_tagline()')
    expect(source).not.toContain(overlayableMessage('shell_brand_tagline'))
    expect(source).not.toContain(overlayableMessage('shell_brand_tagline', 'es'))
  })
})
