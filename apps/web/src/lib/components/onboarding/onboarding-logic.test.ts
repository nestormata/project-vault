import { describe, expect, it, vi } from 'vitest'
import {
  canCreateCredential,
  canCreateProject,
  containsForbiddenStructuralTerm,
  onboardingCopy,
  parseTagsInput,
  validateCredentialForm,
} from './onboarding-logic.js'

describe('onboarding logic', () => {
  it('allows credential creation for member, admin, and owner roles', () => {
    expect(canCreateCredential('member')).toBe(true)
    expect(canCreateCredential('admin')).toBe(true)
    expect(canCreateCredential('owner')).toBe(true)
    expect(canCreateCredential('viewer')).toBe(false)
  })

  it('matches project creation permissions to credential creation', () => {
    expect(canCreateProject('viewer')).toBe(false)
    expect(canCreateProject('member')).toBe(true)
  })

  it('validates credential form fields', () => {
    expect(validateCredentialForm({ name: '', value: '' })).toEqual({
      name: 'Name is required',
      value: 'Credential value cannot be empty',
    })
    expect(validateCredentialForm({ name: 'API_KEY', value: 'secret' })).toEqual({})
  })

  it('parses comma-separated tags', () => {
    expect(parseTagsInput(' prod, api ,staging ')).toEqual(['prod', 'api', 'staging'])
  })

  it('does not use environment as a structural concept in copy', () => {
    expect(onboardingCopy.projectModel).toContain('no environments')
    expect(containsForbiddenStructuralTerm('environment')).toBe(true)
    expect(containsForbiddenStructuralTerm('project-centric')).toBe(false)
  })
})

describe('focus trap', () => {
  it('wraps tab focus within the container', async () => {
    const { trapFocus } = await import('./focus-trap.js')
    const container = document.createElement('div')
    const first = document.createElement('button')
    first.textContent = 'First'
    const last = document.createElement('button')
    last.textContent = 'Last'
    container.append(first, last)
    document.body.append(container)

    const cleanup = trapFocus(container)
    last.focus()

    last.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    )
    expect(document.activeElement).toBe(first)

    cleanup()
    container.remove()
  })
})

describe('onboarding API client', () => {
  it('posts completion payload', async () => {
    const { completeOnboarding } = await import('$lib/api/onboarding.js')
    const fetchFn = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ completed: true, completedAt: '2026-06-29T00:00:00.000Z' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )

    await completeOnboarding(fetchFn)
    expect(fetchFn).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/users/me/onboarding'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ completed: true }),
      })
    )
  })
})
