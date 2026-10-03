import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/svelte'
import ShellBrand from './ShellBrand.svelte'

afterEach(cleanup)

// Story 68.5 AC-10: the brand block extracted from AppShell's header, byte-identical output.
describe('ShellBrand.svelte', () => {
  it('renders the logo mark, a dashboard link and the tagline', () => {
    const { container } = render(ShellBrand, { props: { hidePrimaryNav: false } })

    expect(container.querySelector('img')?.getAttribute('src')).toBe('/logo-mark.png')
    expect(screen.getByRole('link', { name: 'Project Vault' }).getAttribute('href')).toBe(
      '/dashboard'
    )
    expect(screen.getByText('Run complex projects. Miss nothing.')).toBeTruthy()
  })

  it('renders a plain title with no link when hidePrimaryNav is true', () => {
    render(ShellBrand, { props: { hidePrimaryNav: true } })

    expect(screen.queryByRole('link')).toBeNull()
    expect(screen.getByText('Project Vault')).toBeTruthy()
  })
})
