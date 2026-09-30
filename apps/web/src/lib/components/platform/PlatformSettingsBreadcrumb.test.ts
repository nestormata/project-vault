import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/svelte'
import { createRawSnippet } from 'svelte'

import PlatformSettingsBreadcrumb from './PlatformSettingsBreadcrumb.svelte'

afterEach(() => cleanup())

function childrenSnippet(text = 'page body') {
  return createRawSnippet(() => ({
    render: () => `<p>${text}</p>`,
  }))
}

describe('PlatformSettingsBreadcrumb', () => {
  it('renders the Platform Admin > System Settings trail ending in the leaf label', () => {
    render(PlatformSettingsBreadcrumb, {
      props: { allowed: true, leafLabel: 'Organisations', children: childrenSnippet() },
    })

    expect(screen.getByRole('link', { name: 'Platform Admin' }).getAttribute('href')).toBe(
      '/platform'
    )
    expect(screen.getByRole('link', { name: 'System Settings' }).getAttribute('href')).toBe(
      '/platform/settings'
    )
    expect(screen.getByText('Organisations')).toBeTruthy()
  })

  // Story 68.1 AC-3: the trail was a plain const captured at mount, so a new leafLabel on the
  // same component instance (no remount) left the old leaf on screen.
  it('follows a leafLabel change without remounting', async () => {
    const { rerender } = render(PlatformSettingsBreadcrumb, {
      props: { allowed: true, leafLabel: 'Organisations', children: childrenSnippet() },
    })

    await rerender({ leafLabel: 'Resource Usage' })

    expect(screen.getByText('Resource Usage')).toBeTruthy()
    expect(screen.queryByText('Organisations')).toBeNull()
  })
})
