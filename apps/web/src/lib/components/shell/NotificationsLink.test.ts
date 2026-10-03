import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/svelte'
import NotificationsLink from './NotificationsLink.svelte'

afterEach(cleanup)

// Story 68.5 AC-10: the notifications bell extracted from AppShell's header.
describe('NotificationsLink.svelte', () => {
  it('links to /notifications with an accessible name', () => {
    render(NotificationsLink, { props: { unreadCount: 0 } })

    expect(screen.getByRole('link', { name: 'Notifications' }).getAttribute('href')).toBe(
      '/notifications'
    )
  })

  it.each([
    [0, null],
    [5, '5'],
    [99, '99'],
    [100, '99+'],
    [140, '99+'],
  ] as const)('unreadCount %i shows badge %s', (unreadCount, badge) => {
    const { container } = render(NotificationsLink, { props: { unreadCount } })

    expect(container.querySelector('span.absolute')?.textContent?.trim() ?? null).toBe(badge)
  })
})
