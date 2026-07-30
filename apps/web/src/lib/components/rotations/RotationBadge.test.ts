import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/svelte'
import RotationBadge from './RotationBadge.svelte'

afterEach(() => cleanup())

// Story 18.5 AC-1/AC-3/AC-6/AC-7: the shared "rotation in progress" badge used by both the
// credential list and the dashboard's "Upcoming rotations" section.
describe('RotationBadge.svelte', () => {
  it('renders the collapsed "Rotation in progress" label for staged/in_progress/promoted and links to the rotation detail page', () => {
    render(RotationBadge, {
      props: { status: 'staged', href: '/projects/p1/credentials/c1/rotations/r1' },
    })
    const link = screen.getByRole('link', { name: /rotation in progress/i })
    expect(link.getAttribute('href')).toBe('/projects/p1/credentials/c1/rotations/r1')
  })

  it('exposes the precise underlying status via a title/tooltip attribute (AC-7)', () => {
    render(RotationBadge, {
      props: { status: 'stale_recovery', href: '/projects/p1/credentials/c1/rotations/r1' },
    })
    const link = screen.getByRole('link', { name: /rotation needs attention/i })
    expect(link.getAttribute('title')).toContain('stale_recovery')
  })

  it('gives break_glass_complete its own distinct label, not the generic "Rotation in progress" text', () => {
    render(RotationBadge, {
      props: { status: 'break_glass_complete', href: '/projects/p1/credentials/c1/rotations/r1' },
    })
    expect(screen.getByRole('link', { name: /break-glass rotation/i })).toBeTruthy()
    expect(screen.queryByText('Rotation in progress')).toBeNull()
  })
})
