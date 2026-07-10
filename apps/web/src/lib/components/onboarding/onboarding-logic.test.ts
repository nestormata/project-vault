import { describe, expect, it, vi } from 'vitest'
import { ApiClientError } from '$lib/api/client.js'
import {
  canCreateCredential,
  canCreateProject,
  containsForbiddenStructuralTerm,
  mapCredentialSubmitError,
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
    expect(parseTagsInput(' , , ')).toEqual([])
  })

  it('does not use environment as a structural concept in copy', () => {
    expect(onboardingCopy.projectModel).toContain('no environments')
    expect(containsForbiddenStructuralTerm('environment')).toBe(true)
    expect(containsForbiddenStructuralTerm('project-centric')).toBe(false)
  })

  it.each([
    [
      new ApiClientError(
        422,
        {
          message: 'Invalid fields',
          details: { name: ['Duplicate name'], value: ['Value rejected'] },
        },
        'Invalid fields'
      ),
      {
        fieldErrors: { name: 'Duplicate name', value: 'Value rejected' },
        errorMessage: 'Invalid fields',
      },
    ],
    [
      new ApiClientError(
        422,
        { message: 'Invalid fields', details: 'malformed' },
        'Invalid fields'
      ),
      { fieldErrors: { name: undefined, value: undefined }, errorMessage: 'Invalid fields' },
    ],
    [
      new ApiClientError(403, {}, 'Forbidden'),
      { fieldErrors: {}, errorMessage: 'You do not have permission to create credentials.' },
    ],
    [
      new ApiClientError(500, {}, 'Server unavailable'),
      { fieldErrors: {}, errorMessage: 'Server unavailable' },
    ],
    [new Error('network failed'), { fieldErrors: {}, errorMessage: 'network failed' }],
    [{ reason: 'unknown' }, { fieldErrors: {}, errorMessage: 'Could not save credential.' }],
  ])('maps credential submission failures', (failure, expected) => {
    expect(mapCredentialSubmitError(failure)).toEqual(expected)
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

  it('wraps shift-tab backwards and ignores other keys/interior focus', async () => {
    const { trapFocus } = await import('./focus-trap.js')
    const container = document.createElement('div')
    const first = document.createElement('button')
    const middle = document.createElement('input')
    const last = document.createElement('button')
    container.append(first, middle, last)
    document.body.append(container)
    const dispose = trapFocus(container)
    expect(document.activeElement).toBe(first)
    first.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })
    )
    expect(document.activeElement).toBe(last)
    middle.focus()
    middle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    middle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    expect(document.activeElement).toBe(middle)
    dispose()
    container.remove()
  })

  it('handles a container with no focusable elements', async () => {
    const { trapFocus } = await import('./focus-trap.js')
    const container = document.createElement('div')
    document.body.append(container)
    const dispose = trapFocus(container)
    container.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    dispose()
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
