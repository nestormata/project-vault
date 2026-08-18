import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/svelte'
import { routeExists } from '$lib/test/route-exists.js'
import ExtensionsPage from './+page.svelte'

afterEach(() => cleanup())

const SAMPLE_MANIFEST = {
  name: 'com.acme.sso-extension',
  apiVersion: '1.2.0',
  capabilities: ['auth-provider'] as const,
  loadedAt: '2026-07-20T10:00:00.000Z',
}

describe('/settings/extensions +page.svelte', () => {
  it('is a real, existing route', () => {
    expect(routeExists('/settings/extensions')).toBe(true)
  })

  it('AC-5: a non-admin role sees the permission message, not a crash', () => {
    render(ExtensionsPage, { props: { data: { allowed: false, orgRole: 'member' } } })

    expect(screen.getByText(/need the admin role/i)).toBeTruthy()
  })

  it('AC-5: owner is explicitly blocked too, same as member/viewer', () => {
    render(ExtensionsPage, { props: { data: { allowed: false, orgRole: 'owner' } } })

    expect(screen.getByText(/need the admin role/i)).toBeTruthy()
  })

  it('AC-2: loaded state shows name, apiVersion, capability badge, and a formatted timestamp', () => {
    render(ExtensionsPage, {
      props: {
        data: {
          allowed: true,
          orgRole: 'admin',
          mfaRequired: false,
          manifest: SAMPLE_MANIFEST,
          healthStatus: 'loaded',
          errorMessage: null,
        },
      },
    })

    expect(screen.getByText('com.acme.sso-extension')).toBeTruthy()
    expect(screen.getByText(/1\.2\.0/)).toBeTruthy()
    expect(screen.getByText('auth-provider')).toBeTruthy()
    // Not the raw ISO string — a locale-formatted rendering of it.
    expect(screen.queryByText('2026-07-20T10:00:00.000Z')).toBeNull()
  })

  it('AC-2 edge: empty capabilities array shows "No capabilities declared", not a blank row', () => {
    render(ExtensionsPage, {
      props: {
        data: {
          allowed: true,
          orgRole: 'admin',
          mfaRequired: false,
          manifest: { ...SAMPLE_MANIFEST, capabilities: [] },
          healthStatus: 'loaded',
          errorMessage: null,
        },
      },
    })

    expect(screen.getByText(/no capabilities declared/i)).toBeTruthy()
  })

  it('code review: duplicate capability entries render without crashing (each_key_duplicate)', () => {
    // status-routes.ts's ExtensionStatusResponseSchema validates enum membership only, not
    // array uniqueness — a malformed manifest can declare the same capability twice. A
    // value-keyed {#each} throws a Svelte each_key_duplicate runtime error in that case,
    // crashing the whole page for the admin viewing it. Confirmed via manual repro before the
    // fix (index-keyed {#each}) was applied.
    expect(() =>
      render(ExtensionsPage, {
        props: {
          data: {
            allowed: true,
            orgRole: 'admin',
            mfaRequired: false,
            manifest: { ...SAMPLE_MANIFEST, capabilities: ['auth-provider', 'auth-provider'] },
            healthStatus: 'loaded',
            errorMessage: null,
          },
        },
      })
    ).not.toThrow()

    expect(screen.getAllByText('auth-provider')).toHaveLength(2)
  })

  it('AC-3: not-configured state renders an honest, non-alarming empty state', () => {
    render(ExtensionsPage, {
      props: {
        data: {
          allowed: true,
          orgRole: 'admin',
          mfaRequired: false,
          manifest: null,
          healthStatus: 'not_configured',
          errorMessage: null,
        },
      },
    })

    expect(screen.getByText(/no extension configured for this vault/i)).toBeTruthy()
  })

  it('AC-4: load-failed state is distinct from not-configured, never links to /settings/audit', () => {
    // Every viewer who reaches this branch is org role 'admin' (AC-5's page gate blocks
    // owner/member/viewer entirely), and /settings/audit gates on 'owner' specifically — a
    // stricter role than this page's own gate. A link here could never resolve for a real
    // viewer, so this state is text-only, no link, for every reachable orgRole.
    render(ExtensionsPage, {
      props: {
        data: {
          allowed: true,
          orgRole: 'admin',
          mfaRequired: false,
          manifest: null,
          healthStatus: 'load_failed',
          errorMessage: null,
        },
      },
    })

    expect(screen.getByText(/failed to load/i)).toBeTruthy()
    expect(screen.queryByText(/no extension configured/i)).toBeNull()
    expect(screen.queryByRole('link', { name: /audit/i })).toBeNull()
  })

  it('AC-7: generic fetch failure keeps the rest of the page intact', () => {
    render(ExtensionsPage, {
      props: {
        data: {
          allowed: true,
          orgRole: 'admin',
          mfaRequired: false,
          manifest: null,
          healthStatus: null,
          errorMessage: 'Failed to load extension status, try again.',
        },
      },
    })

    expect(screen.getByText(/failed to load extension status, try again/i)).toBeTruthy()
    expect(screen.getByRole('heading', { name: /extensions/i })).toBeTruthy()
  })

  it('AC-7 edge: MFA-not-enrolled admin sees a distinct message linking to /settings/security', () => {
    render(ExtensionsPage, {
      props: {
        data: {
          allowed: true,
          orgRole: 'admin',
          mfaRequired: true,
          manifest: null,
          healthStatus: null,
          errorMessage: null,
        },
      },
    })

    expect(screen.getByText(/multi-factor authentication/i)).toBeTruthy()
    const link = screen.getByRole('link', { name: /security/i })
    expect(link.getAttribute('href')).toBe('/settings/security')
    // Distinct from the generic failure and the permission-denied messages.
    expect(screen.queryByText(/failed to load extension status/i)).toBeNull()
    expect(screen.queryByText(/need the admin role/i)).toBeNull()
  })

  it('Story 23.3 AC-9: manifest without capability-gate shows the "no gate configured" line', () => {
    render(ExtensionsPage, {
      props: {
        data: {
          allowed: true,
          orgRole: 'admin',
          mfaRequired: false,
          manifest: SAMPLE_MANIFEST,
          healthStatus: 'loaded',
          errorMessage: null,
        },
      },
    })

    expect(
      screen.getByText(/no capability gate configured — all capabilities are available/i)
    ).toBeTruthy()
    expect(screen.queryByText(/this extension declares a capability gate/i)).toBeNull()
  })

  it('Story 23.3 AC-9: manifest declaring capability-gate shows the "declares a gate" line, not a liveness claim', () => {
    render(ExtensionsPage, {
      props: {
        data: {
          allowed: true,
          orgRole: 'admin',
          mfaRequired: false,
          manifest: { ...SAMPLE_MANIFEST, capabilities: ['auth-provider', 'capability-gate'] },
          healthStatus: 'loaded',
          errorMessage: null,
        },
      },
    })

    expect(screen.getByText(/this extension declares a capability gate/i)).toBeTruthy()
    expect(screen.getByText(/operational status endpoint/i)).toBeTruthy()
    expect(
      screen.queryByText(/no capability gate configured — all capabilities are available/i)
    ).toBeNull()
  })

  it('Story 23.3 AC-9: not-configured state also shows the "no gate configured" line', () => {
    render(ExtensionsPage, {
      props: {
        data: {
          allowed: true,
          orgRole: 'admin',
          mfaRequired: false,
          manifest: null,
          healthStatus: 'not_configured',
          errorMessage: null,
        },
      },
    })

    expect(
      screen.getByText(/no capability gate configured — all capabilities are available/i)
    ).toBeTruthy()
  })

  it('Story 23.8 AC-26: manifest without audit-event-source shows the "not declared" line', () => {
    render(ExtensionsPage, {
      props: {
        data: {
          allowed: true,
          orgRole: 'admin',
          mfaRequired: false,
          manifest: SAMPLE_MANIFEST,
          healthStatus: 'loaded',
          errorMessage: null,
        },
      },
    })

    expect(screen.getByText(/audit event source: not declared/i)).toBeTruthy()
  })

  it('Story 23.8 AC-26: manifest declaring audit-event-source shows the "declared" line', () => {
    render(ExtensionsPage, {
      props: {
        data: {
          allowed: true,
          orgRole: 'admin',
          mfaRequired: false,
          manifest: { ...SAMPLE_MANIFEST, capabilities: ['auth-provider', 'audit-event-source'] },
          healthStatus: 'loaded',
          errorMessage: null,
        },
      },
    })

    expect(screen.getByText(/audit event source: declared/i)).toBeTruthy()
    expect(screen.queryByText(/audit event source: not declared/i)).toBeNull()
  })

  it('Story 23.8 AC-26: not-configured and load-failed states also show the "not declared" line', () => {
    render(ExtensionsPage, {
      props: {
        data: {
          allowed: true,
          orgRole: 'admin',
          mfaRequired: false,
          manifest: null,
          healthStatus: 'not_configured',
          errorMessage: null,
        },
      },
    })
    expect(screen.getByText(/audit event source: not declared/i)).toBeTruthy()
    cleanup()

    render(ExtensionsPage, {
      props: {
        data: {
          allowed: true,
          orgRole: 'admin',
          mfaRequired: false,
          manifest: null,
          healthStatus: 'load_failed',
          errorMessage: null,
        },
      },
    })
    expect(screen.getByText(/audit event source: not declared/i)).toBeTruthy()
  })
})
