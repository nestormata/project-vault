import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/svelte'
import RootPage from './+page.svelte'

afterEach(() => cleanup())

// This markup is normally unreachable at runtime — +page.server.ts's load() always redirects to
// /vault, /dashboard, or /login (see routes/vault.test.ts) — but it still ships as a fallback if
// SvelteKit ever renders the route without running its load function, so it should render
// something real rather than nothing.
describe('root page fallback markup', () => {
  it('renders the app name as both the document title and a visible heading', () => {
    const { container } = render(RootPage)

    expect(document.title).toBe('Project Vault')
    expect(container.querySelector('h1')?.textContent).toBe('Project Vault')
  })
})
