// Story 68.7 AC-2/AC-3/Q11: the shell's small surfaces (account menu, utility cluster, footer)
// render a CM delta at any depth as nested disclosures, and a replaced PV action runs CM's handler.
// Kept apart from nav-delta-render.test.ts because a composed app may REPLACE these components (M4,
// the mini pack replaces ShellAccount and Footer): then this file describes PV's components, not the
// composed ones, and the composition-kit integration job leaves it out of the composed run.
import { cleanup, fireEvent, render, screen, within } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { reactivePage } from '$lib/test/reactive-page.svelte.js'
import { testAuthUser } from '$lib/test/page-data.js'
import type { NavDelta } from './types.js'
import { subtree } from './nav-render-test-helpers.js'

const holder = vi.hoisted(() => ({ delta: {} as unknown }))

vi.mock('$app/state', () => ({ page: reactivePage }))
vi.mock('$app/navigation', () => ({ goto: vi.fn(async () => undefined) }))
vi.mock('$lib/api/auth.js', () => ({ logout: vi.fn(async () => undefined) }))
vi.mock('$lib/navigation/active-delta.js', () => ({
  get activeDelta() {
    return holder.delta
  },
}))

import Footer from '$lib/components/shell/Footer.svelte'
import NotificationsLink from '$lib/components/shell/NotificationsLink.svelte'
import ShellAccount from '$lib/components/shell/ShellAccount.svelte'

function useDelta(delta: NavDelta): void {
  holder.delta = delta
}

afterEach(() => {
  cleanup()
  useDelta({})
})

describe('the shell surfaces render a CM delta (Story 68.7 AC-2/AC-3)', () => {
  it('account menu, utility cluster and footer: nested disclosures', () => {
    useDelta({
      account: [{ op: 'insert', after: 'account.sign-out', item: subtree('cm.a', 6, '/billing') }],
      'shell.utility': [
        { op: 'insert', parent: 'shell.utility', item: subtree('cm.u', 6, '/help') },
      ],
      footer: [{ op: 'insert', parent: 'footer', item: subtree('cm.f', 6, '/about') }],
    })
    for (const [component, props] of [
      [ShellAccount, { user: testAuthUser() }],
      [NotificationsLink, { unreadCount: 2 }],
      [Footer, {}],
    ] as const) {
      const { container, unmount } = render(component as never, { props } as never)
      expect(container.querySelectorAll('details')).toHaveLength(5)
      expect(within(container).getByRole('link', { name: 'L6' })).toBeTruthy()
      unmount()
    }
  })

  it('a replaced sign-out runs the CM action', async () => {
    const onSelect = vi.fn()
    useDelta({
      account: [
        {
          op: 'replace',
          id: 'account.sign-out',
          item: { label: 'Leave', kind: 'action', onSelect },
        },
      ],
    })
    render(ShellAccount, { props: { user: testAuthUser() } })
    await fireEvent.click(screen.getByRole('button', { name: 'Leave' }))
    expect(onSelect).toHaveBeenCalledOnce()
  })
})
