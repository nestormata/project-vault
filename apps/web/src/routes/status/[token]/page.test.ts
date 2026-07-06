import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/svelte'
import PublicStatusPage from './+page.svelte'

afterEach(() => cleanup())

describe('public status page (Story 6.3 AC 12/15)', () => {
  it('renders a displayName containing <, >, & as a literal text node, never as markup', async () => {
    const injected = '<script>alert(1)</script>&"quoted"'
    const { container } = render(PublicStatusPage, {
      props: {
        data: {
          statusPage: {
            services: [{ displayName: injected, status: 'healthy', lastCheckedAt: null }],
          },
        },
      },
    })

    // The literal string must appear as rendered text content...
    expect(container.textContent).toContain(injected)
    // ...and must NOT have been parsed into an executable <script> element (which {@html} would
    // produce) — Svelte's default {expression} interpolation always escapes markup.
    expect(container.querySelector('script')).toBeNull()
  })

  it('shows the not-available state when the token is invalid/disabled', () => {
    const { getByText } = render(PublicStatusPage, { props: { data: { statusPage: null } } })
    expect(getByText('Status page not available')).toBeTruthy()
  })

  it('shows an empty-state message when no services are configured', () => {
    const { getByText } = render(PublicStatusPage, {
      props: { data: { statusPage: { services: [] } } },
    })
    expect(getByText('No services are currently listed on this status page.')).toBeTruthy()
  })
})
