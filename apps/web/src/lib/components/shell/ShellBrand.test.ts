import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/svelte'
import ShellBrand from './ShellBrand.svelte'
import { overlayableMessage } from '$lib/test/overlayable-messages.js'
import { m } from '$lib/paraglide/messages.js'
import en from '../../../../messages/en.json'
import es from '../../../../messages/es.json'

afterEach(cleanup)

// Story 68.5 AC-10: the brand block extracted from AppShell's header, byte-identical output.
describe('ShellBrand.svelte', () => {
  it('renders the logo mark, a dashboard link and the tagline', () => {
    const { container } = render(ShellBrand, { props: { hidePrimaryNav: false } })

    expect(container.querySelector('img')?.getAttribute('src')).toBe('/logo-mark.png')
    expect(screen.getByRole('link', { name: 'Project Vault' }).getAttribute('href')).toBe(
      '/dashboard'
    )
    expect(screen.getByText(m.shell_brand_tagline())).toBeTruthy()
  })

  // Story 72.17 AC-1: the tagline is a message key (a host overlays it, no component replacement).
  // Story 72.19: this test does not write its default text, so a host overlay keeps it green; the
  // unchanged default is proved by the j45 journey on PV's own stack, which no pack touches.
  it('reads the tagline from the shell_brand_tagline message in every locale', () => {
    expect(m.shell_brand_tagline()).not.toBe('')
    expect(overlayableMessage('shell_brand_tagline', 'es')).not.toBe('')
    expect(en.shell_brand_tagline).not.toBe('')
    expect(es.shell_brand_tagline).not.toBe('')
  })

  it('shows the tagline in the onboarding variant too', () => {
    render(ShellBrand, { props: { hidePrimaryNav: true } })

    expect(screen.getByText(m.shell_brand_tagline())).toBeTruthy()
  })

  it('renders a plain title with no link when hidePrimaryNav is true', () => {
    render(ShellBrand, { props: { hidePrimaryNav: true } })

    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.getByText('Project Vault')).toBeTruthy()
  })
})
