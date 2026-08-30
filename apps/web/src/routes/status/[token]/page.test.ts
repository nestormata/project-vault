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

  // Story 28.7 AC5/AC6: this fixture ({ status: 'healthy', lastCheckedAt: null }) is the exact
  // combination Finding 6's QA walkthrough hit — a never-checked endpoint must render one honest
  // "not checked yet" state, not that plus a contradictory "healthy" badge.
  it('Story 28.7 AC5: a never-checked service (status healthy, lastCheckedAt null) shows one honest pending state, not a contradictory healthy badge', () => {
    const { getByText, queryByText } = render(PublicStatusPage, {
      props: {
        data: {
          statusPage: {
            services: [{ displayName: 'API', status: 'healthy', lastCheckedAt: null }],
          },
        },
      },
    })

    expect(getByText('Not checked yet')).toBeTruthy()
    expect(queryByText('healthy')).toBeNull()
  })

  // Story 28.7 AC8: regression guard — once a real check has run, the row must render exactly as
  // it does today (real "checked at" time + the real status badge).
  it('Story 28.7 AC8: a service with a real lastCheckedAt renders the real checked-at time and the real status badge', () => {
    const { getByText, queryByText } = render(PublicStatusPage, {
      props: {
        data: {
          statusPage: {
            services: [
              { displayName: 'API', status: 'degraded', lastCheckedAt: '2026-08-28T00:00:00.000Z' },
            ],
          },
        },
      },
    })

    expect(queryByText('Not checked yet')).toBeNull()
    expect(getByText('degraded')).toBeTruthy()
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
