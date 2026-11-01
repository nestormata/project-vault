import { m } from '$lib/paraglide/messages.js'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/svelte'
import ShellBrand from './ShellBrand.svelte'
import { m } from '$lib/paraglide/messages.js'
import en from '../../../../messages/en.json'
import es from '../../../../messages/es.json'

afterEach(cleanup)

// Story 68.5 AC-10: the brand block extracted from AppShell's header, byte-identical output.
describe('ShellBrand.svelte', () => {
  it('renders the logo mark, a dashboard link and the tagline', () => {
    const { container } = render(ShellBrand, { props: { hidePrimaryNav: false } })

    expect(container.querySelector('img')?.getAttribute('src')).toBe('/logo-mark.png')
    expect(screen.getByRole('link', { name: m.brand_name() }).getAttribute('href')).toBe(
      '/dashboard'
    )
    expect(screen.getByText(m.shell_brand_tagline())).toBeTruthy()
  })

  // Story 72.17 AC-1: the tagline is a message key (a host overlays it, no component replacement),
  // and its default text is the sentence PV rendered before the key existed.
  it('reads the tagline from the shell_brand_tagline message with the unchanged default text', () => {
    expect(m.shell_brand_tagline()).toBe('Run complex projects. Miss nothing.')
    expect(en.shell_brand_tagline).toBe('Run complex projects. Miss nothing.')
    expect(es.shell_brand_tagline).toBe('Run complex projects. Miss nothing.')
  })

  it('shows the tagline in the onboarding variant too', () => {
    render(ShellBrand, { props: { hidePrimaryNav: true } })

    expect(screen.getByText(m.shell_brand_tagline())).toBeTruthy()
  })

  it('renders a plain title with no link when hidePrimaryNav is true', () => {
    render(ShellBrand, { props: { hidePrimaryNav: true } })

    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.getByText(m.brand_name())).toBeTruthy()
  })
})
