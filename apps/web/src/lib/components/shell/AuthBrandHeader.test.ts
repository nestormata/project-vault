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
    expect(screen.getByText('Project Vault')).toBeTruthy()
  })
})
