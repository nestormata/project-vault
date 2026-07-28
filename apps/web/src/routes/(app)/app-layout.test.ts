import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import { createRawSnippet } from 'svelte'
import {
  credentialCreateSuccess,
  fillCredentialForm,
  goToCredentialStep,
  installFetchMock,
  onboardingTestProject,
  onboardingTestUser,
} from '$lib/components/onboarding/onboarding-test-helpers.js'

const invalidateAllMock = vi.hoisted(() => vi.fn(async () => {}))

vi.mock('$app/navigation', () => ({
  goto: vi.fn(async () => {}),
  invalidateAll: invalidateAllMock,
}))

vi.mock('$app/state', () => ({
  page: { url: new URL('http://localhost/dashboard') },
}))

vi.mock('$lib/api/auth.js', () => ({
  logout: vi.fn(async () => undefined),
}))

import Layout from './+layout.svelte'

beforeEach(() => {
  invalidateAllMock.mockReset()
  invalidateAllMock.mockImplementation(async () => {})
})

afterEach(() => cleanup())

function childrenSnippet(text = 'protected app content') {
  return createRawSnippet(() => ({
    render: () => `<p>${text}</p>`,
  }))
}

describe('/(app) +layout.svelte', () => {
  it('renders the onboarding wizard (not children) when onboarding is not completed', () => {
    render(Layout, {
      props: {
        data: {
          user: onboardingTestUser,
          onboardingCompleted: false,
          projects: [onboardingTestProject],
          importRouteLive: true,
          unreadCount: 2,
        },
        children: childrenSnippet(),
      },
    })

    expect(screen.getByText(/Welcome to Project Vault/i)).toBeTruthy()
    expect(screen.queryByText('protected app content')).toBeNull()
  })

  it('renders the page children (not the wizard) when onboarding is completed', () => {
    render(Layout, {
      props: {
        data: {
          user: onboardingTestUser,
          onboardingCompleted: true,
          projects: [],
          importRouteLive: false,
          unreadCount: 0,
        },
        children: childrenSnippet(),
      },
    })

    expect(screen.getByText('protected app content')).toBeTruthy()
    expect(screen.queryByText(/Welcome to Project Vault/i)).toBeNull()
  })

  it('defaults the initial unread count to 0 when data.unreadCount is undefined', () => {
    render(Layout, {
      props: {
        data: {
          user: onboardingTestUser,
          onboardingCompleted: true,
          projects: [],
          importRouteLive: false,
        },
        children: childrenSnippet(),
      },
    })

    // With onboarding completed, AppShell renders with hidePrimaryNav=false,
    // so the notifications bell (with no badge, since unreadCount defaults to 0) is shown.
    const bell = screen.getByLabelText('Notifications')
    expect(bell.querySelector('span.absolute')).toBeNull()
  })

  it('passes through a defined unread count to AppShell (badge visible)', () => {
    render(Layout, {
      props: {
        data: {
          user: onboardingTestUser,
          onboardingCompleted: true,
          projects: [],
          importRouteLive: false,
          unreadCount: 9,
        },
        children: childrenSnippet(),
      },
    })

    expect(screen.getByText('9')).toBeTruthy()
  })

  it('AC-1/2/3: invalidates all load data (fresh dashboard data) before revealing children once onboarding completes, even with a slow final mutation', async () => {
    const callOrder: string[] = []
    invalidateAllMock.mockImplementation(async () => {
      callOrder.push('invalidateAll')
    })

    let resolveComplete!: () => void
    installFetchMock((url, init) => {
      if (String(url).includes('/credentials') && init?.method === 'POST') {
        return credentialCreateSuccess()
      }
      if (String(url).includes('/users/me/onboarding') && init?.method === 'POST') {
        return new Promise((resolve) => {
          resolveComplete = () => {
            callOrder.push('completeOnboarding')
            resolve(
              new Response(JSON.stringify({ completed: true, completedAt: 'now' }), {
                status: 200,
              })
            )
          }
        })
      }
      return new Response(JSON.stringify({ completed: false }), { status: 200 })
    })

    render(Layout, {
      props: {
        data: {
          user: onboardingTestUser,
          onboardingCompleted: false,
          projects: [onboardingTestProject],
          importRouteLive: false,
          unreadCount: 0,
        },
        children: childrenSnippet(),
      },
    })

    await goToCredentialStep(screen, fireEvent)
    await fillCredentialForm(screen, fireEvent, { name: 'MY_API_KEY', value: 'sk_live_abc123' })
    await fireEvent.click(screen.getByRole('button', { name: /Save Credential/i }))
    await fireEvent.click(await screen.findByRole('button', { name: 'Next' }))
    await fireEvent.click(screen.getByRole('button', { name: /Go to Dashboard/i }))

    // Slow backend: children must not appear while the final mutation is still in flight.
    expect(screen.queryByText('protected app content')).toBeNull()
    expect(invalidateAllMock).not.toHaveBeenCalled()

    resolveComplete()
    await vi.waitFor(() => expect(screen.getByText('protected app content')).toBeTruthy())

    expect(invalidateAllMock).toHaveBeenCalledTimes(1)
    expect(callOrder).toEqual(['completeOnboarding', 'invalidateAll'])
  })

  it('AC-4: a failed final mutation keeps the wizard open with an inline error instead of transitioning to a stale dashboard', async () => {
    installFetchMock((url, init) => {
      if (String(url).includes('/credentials') && init?.method === 'POST') {
        return credentialCreateSuccess()
      }
      if (String(url).includes('/users/me/onboarding') && init?.method === 'POST') {
        return new Response(JSON.stringify({ message: 'boom' }), { status: 500 })
      }
      return new Response(JSON.stringify({ completed: false }), { status: 200 })
    })

    render(Layout, {
      props: {
        data: {
          user: onboardingTestUser,
          onboardingCompleted: false,
          projects: [onboardingTestProject],
          importRouteLive: false,
          unreadCount: 0,
        },
        children: childrenSnippet(),
      },
    })

    await goToCredentialStep(screen, fireEvent)
    await fillCredentialForm(screen, fireEvent, { name: 'MY_API_KEY', value: 'sk_live_abc123' })
    await fireEvent.click(screen.getByRole('button', { name: /Save Credential/i }))
    await fireEvent.click(await screen.findByRole('button', { name: 'Next' }))
    await fireEvent.click(screen.getByRole('button', { name: /Go to Dashboard/i }))

    expect(await screen.findByText(/something went wrong/i)).toBeTruthy()
    expect(screen.queryByText('protected app content')).toBeNull()
    expect(invalidateAllMock).not.toHaveBeenCalled()
  })

  describe('theme application (Story 16.2 AC-2/AC-3)', () => {
    beforeEach(() => {
      sessionStorage.clear()
    })

    function baseData(overrides: Record<string, unknown> = {}) {
      return {
        user: onboardingTestUser,
        onboardingCompleted: true,
        projects: [],
        importRouteLive: false,
        unreadCount: 0,
        appliedTheme: null,
        orphanedNotice: false,
        orphanedThemeName: null,
        themeCss: '',
        ...overrides,
      }
    }

    it('AC-2: renders the applied theme as a data-theme attribute (no FOUC — set directly, not after mount)', () => {
      const { container } = render(Layout, {
        props: { data: baseData({ appliedTheme: 'acme-brand' }), children: childrenSnippet() },
      })

      expect(container.querySelector('[data-theme="acme-brand"]')).toBeTruthy()
    })

    it('AC-2 edge: omits data-theme entirely for the base theme (never data-theme="base")', () => {
      const { container } = render(Layout, {
        props: { data: baseData({ appliedTheme: null }), children: childrenSnippet() },
      })

      expect(container.querySelector('[data-theme]')).toBeNull()
    })

    it('AC-2: renders the compiled theme CSS inline (never via {@html}, via a real <style> element)', () => {
      const { container } = render(Layout, {
        props: {
          data: baseData({ themeCss: '[data-theme="acme-brand"] { --radius-md: 4px; }' }),
          children: childrenSnippet(),
        },
      })

      const styleEl = container.querySelector('style')
      expect(styleEl?.textContent).toContain('--radius-md: 4px')
    })

    it('AC-3: shows a dismissible orphaned-theme notice exactly once, and dismissing it hides it', async () => {
      render(Layout, {
        props: {
          data: baseData({ orphanedNotice: true, orphanedThemeName: 'acme-brand' }),
          children: childrenSnippet(),
        },
      })

      expect(screen.getByText(/no longer available/i)).toBeTruthy()

      await fireEvent.click(screen.getByRole('button', { name: /dismiss/i }))

      expect(screen.queryByText(/no longer available/i)).toBeNull()
      expect(sessionStorage.getItem('dismissedOrphanedTheme')).toBe('acme-brand')
    })

    it('AC-3: does not re-show the notice for the same orphaned theme already dismissed this session', () => {
      sessionStorage.setItem('dismissedOrphanedTheme', 'acme-brand')

      render(Layout, {
        props: {
          data: baseData({ orphanedNotice: true, orphanedThemeName: 'acme-brand' }),
          children: childrenSnippet(),
        },
      })

      expect(screen.queryByText(/no longer available/i)).toBeNull()
    })

    it('AC-3: re-shows the notice for a newly, differently orphaned theme even if another was already dismissed', () => {
      sessionStorage.setItem('dismissedOrphanedTheme', 'acme-brand')

      render(Layout, {
        props: {
          data: baseData({ orphanedNotice: true, orphanedThemeName: 'second-theme' }),
          children: childrenSnippet(),
        },
      })

      expect(screen.getByText(/no longer available/i)).toBeTruthy()
    })
  })
})
