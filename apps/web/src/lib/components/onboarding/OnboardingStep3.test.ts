import { describe, expect, it, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/svelte'
import OnboardingStep3 from './OnboardingStep3.svelte'

const projectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

describe('OnboardingStep3 — Invite your team deep link (AC-I1)', () => {
  afterEach(() => cleanup())

  it('AC-I1: links to the project-scoped Members page when a project exists', () => {
    render(OnboardingStep3, {
      props: { projectId, oncompleted: vi.fn(), headingId: 'step3-heading' },
    })

    const link = screen.getByRole('link', { name: 'Invite your team' })
    expect(link.getAttribute('href')).toBe(`/projects/${projectId}/members`)
  })

  it('AC-I1 edge: falls back to plain, non-linked text when projectId is null', () => {
    render(OnboardingStep3, {
      props: { projectId: null, oncompleted: vi.fn(), headingId: 'step3-heading' },
    })

    expect(screen.queryByRole('link', { name: 'Invite your team' })).toBeNull()
    expect(screen.getByText("Invite your team from the project's Members page")).toBeTruthy()
  })
})
