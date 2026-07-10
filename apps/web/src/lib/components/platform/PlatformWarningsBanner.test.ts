import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/svelte'
import { routeExists } from '$lib/test/route-exists.js'

import PlatformWarningsBanner from './PlatformWarningsBanner.svelte'

afterEach(() => cleanup())

const MESSAGES = {
  audit_storage_critical: {
    message: 'Audit log storage is at critical capacity.',
    linkHref: '/platform/settings/resource-usage',
    linkText: 'Resource Usage',
  },
  key_custody_risk: {
    message: 'Master key custody risk.',
  },
}

describe('PlatformWarningsBanner', () => {
  it('renders nothing when there are no warnings', () => {
    const { container } = render(PlatformWarningsBanner, {
      props: { warnings: [], messages: MESSAGES },
    })

    expect(container.querySelector('[role="alert"]')).toBeNull()
  })

  it('renders a banner with message and a working link when linkHref/linkText are set', () => {
    render(PlatformWarningsBanner, {
      props: { warnings: ['audit_storage_critical'], messages: MESSAGES },
    })

    expect(screen.getByText(/audit log storage is at critical capacity/i)).toBeTruthy()
    const link = screen.getByRole('link', { name: /resource usage/i })
    expect(link.getAttribute('href')).toBe('/platform/settings/resource-usage')
    expect(routeExists(link.getAttribute('href') ?? '')).toBe(true)
  })

  it('renders a banner with no link when linkHref/linkText are absent', () => {
    render(PlatformWarningsBanner, {
      props: { warnings: ['key_custody_risk'], messages: MESSAGES },
    })

    expect(screen.getByText(/master key custody risk/i)).toBeTruthy()
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('renders one banner per warning, preserving order', () => {
    render(PlatformWarningsBanner, {
      props: {
        warnings: ['audit_storage_critical', 'key_custody_risk'],
        messages: MESSAGES,
      },
    })

    const alerts = screen.getAllByRole('alert')
    expect(alerts).toHaveLength(2)
    expect(alerts[0]?.textContent).toMatch(/critical capacity/i)
    expect(alerts[1]?.textContent).toMatch(/custody risk/i)
  })

  it('silently ignores an unknown warning code (no crash, no blank alert)', () => {
    render(PlatformWarningsBanner, {
      props: { warnings: ['some_future_unknown_code'], messages: MESSAGES },
    })

    expect(screen.queryByRole('alert')).toBeNull()
  })
})
