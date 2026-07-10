import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/svelte'
import { createRawSnippet } from 'svelte'
import {
  onboardingTestProject,
  onboardingTestUser,
} from '$lib/components/onboarding/onboarding-test-helpers.js'

vi.mock('$app/navigation', () => ({
  goto: vi.fn(async () => {}),
}))

vi.mock('$app/state', () => ({
  page: { url: new URL('http://localhost/dashboard') },
}))

vi.mock('$lib/api/auth.js', () => ({
  logout: vi.fn(async () => undefined),
}))

import Layout from './+layout.svelte'

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
})
