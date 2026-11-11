import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { m } from '$lib/paraglide/messages.js'
import { overlayableMessage } from '$lib/test/overlayable-messages.js'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/svelte'
import RootHomeContent from './RootHomeContent.svelte'

afterEach(() => cleanup())

describe('RootHomeContent.svelte', () => {
  it('renders the brand name and the shell tagline message', () => {
    render(RootHomeContent)

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(m.brand_name())
    expect(screen.getByText(m.shell_brand_tagline())).toBeTruthy()
  })

  it('reads the tagline from the shell_brand_tagline message in every locale', () => {
    expect(m.shell_brand_tagline()).not.toBe('')
    expect(overlayableMessage('shell_brand_tagline', 'es')).not.toBe('')
  })

  it('does not hard-code the default tagline sentence', () => {
    const source = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'RootHomeContent.svelte'),
      'utf8'
    )
    expect(source).toContain('m.shell_brand_tagline()')
    expect(source).not.toContain(overlayableMessage('shell_brand_tagline'))
    expect(source).not.toContain(overlayableMessage('shell_brand_tagline', 'es'))
  })
})
