import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/svelte'
import { createRawSnippet } from 'svelte'
import { routeExists } from '$lib/test/route-exists.js'

import PlatformBreadcrumb from './PlatformBreadcrumb.svelte'

afterEach(() => cleanup())

function childrenSnippet(text = 'page body') {
  return createRawSnippet(() => ({
    render: () => `<p>${text}</p>`,
  }))
}

describe('PlatformBreadcrumb', () => {
  it('renders the platform-operator-required notice and no trail/children when not allowed', () => {
    render(PlatformBreadcrumb, {
      props: {
        allowed: false,
        trail: [{ label: 'Platform Admin', href: '/platform' }],
        children: childrenSnippet('secret content'),
      },
    })

    expect(screen.getByRole('heading', { name: /platform operator access required/i })).toBeTruthy()
    expect(screen.queryByText('secret content')).toBeNull()
  })

  it('renders a linked crumb for entries with an href, and a plain span for the leaf', () => {
    render(PlatformBreadcrumb, {
      props: {
        allowed: true,
        trail: [{ label: 'Platform Admin', href: '/platform' }, { label: 'Backups' }],
        children: childrenSnippet(),
      },
    })

    const link = screen.getByRole('link', { name: 'Platform Admin' })
    expect(link.getAttribute('href')).toBe('/platform')
    expect(routeExists(link.getAttribute('href') ?? '')).toBe(true)
    expect(screen.getByText('Backups').tagName).toBe('SPAN')
    expect(screen.queryByRole('link', { name: 'Backups' })).toBeNull()
  })

  it('renders the separator only between crumbs, not before the first one', () => {
    const { container } = render(PlatformBreadcrumb, {
      props: {
        allowed: true,
        trail: [
          { label: 'Platform Admin', href: '/platform' },
          { label: 'System Settings', href: '/platform/settings' },
          { label: 'Organizations' },
        ],
        children: childrenSnippet(),
      },
    })

    const separators = container.querySelectorAll('nav span.mx-2')
    expect(separators).toHaveLength(2)
  })

  it('renders the provided children content inside the allowed layout', () => {
    render(PlatformBreadcrumb, {
      props: {
        allowed: true,
        trail: [{ label: 'Platform Admin', href: '/platform' }],
        children: childrenSnippet('unique child marker'),
      },
    })

    expect(screen.getByText('unique child marker')).toBeTruthy()
  })

  it('applies a custom maxWidth class when provided', () => {
    const { container } = render(PlatformBreadcrumb, {
      props: {
        allowed: true,
        trail: [{ label: 'Platform Admin', href: '/platform' }],
        maxWidth: 'max-w-xl',
        children: childrenSnippet(),
      },
    })

    expect(container.querySelector('.max-w-xl')).toBeTruthy()
    expect(container.querySelector('.max-w-5xl')).toBeNull()
  })
})
