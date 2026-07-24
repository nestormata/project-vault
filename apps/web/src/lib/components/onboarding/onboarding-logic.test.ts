import { describe, expect, it, vi } from 'vitest'
import { ApiClientError } from '$lib/api/client.js'
import {
  buildTemplateFieldDrafts,
  canCreateCredential,
  canCreateProject,
  containsForbiddenStructuralTerm,
  duplicateFieldKeyIndex,
  mapCredentialSubmitError,
  onboardingCopy,
  parseTagsInput,
  validateCredentialForm,
  validateFieldSet,
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
    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    container.dispatchEvent(event)
    // Empty focusable set: Tab must not be intercepted (defaultPrevented stays false).
    expect(event.defaultPrevented).toBe(false)
    expect(() => dispose()).not.toThrow()
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

describe('field-set form logic (Story 13.2)', () => {
  it('buildTemplateFieldDrafts pre-populates a template with empty values (AC-1/AC-2)', () => {
    expect(buildTemplateFieldDrafts('login')).toEqual([
      { key: 'username', value: '', sensitive: false },
      { key: 'password', value: '', sensitive: true },
    ])
    expect(buildTemplateFieldDrafts('custom')).toEqual([])
  })

  it('duplicateFieldKeyIndex flags a case-insensitive collision (client affordance, AC-3)', () => {
    expect(duplicateFieldKeyIndex([{ key: 'user' }, { key: 'User' }])).toBe(1)
    expect(duplicateFieldKeyIndex([{ key: 'user' }, { key: 'pass' }])).toBe(-1)
    // blank keys are not compared as duplicates
    expect(duplicateFieldKeyIndex([{ key: '' }, { key: '' }])).toBe(-1)
  })

  it('validateFieldSet requires at least one field', () => {
    const res = validateFieldSet([])
    expect(res.ok).toBe(false)
    expect(res.formError).toMatch(/at least one field/i)
  })

  it('validateFieldSet flags empty and invalid keys', () => {
    const res = validateFieldSet([
      { key: '', value: 'x', sensitive: false },
      { key: 'bad/key', value: 'y', sensitive: false },
    ])
    expect(res.ok).toBe(false)
    expect(res.fieldErrors[0]).toMatch(/required/i)
    expect(res.fieldErrors[1]).toMatch(/letters/i)
  })

  it('validateFieldSet flags a duplicate key on the colliding row', () => {
    const res = validateFieldSet([
      { key: 'token', value: 'a', sensitive: true },
      { key: 'Token', value: 'b', sensitive: true },
    ])
    expect(res.ok).toBe(false)
    expect(res.fieldErrors[1]).toMatch(/duplicate/i)
  })

  it('validateFieldSet passes a clean field set', () => {
    expect(
      validateFieldSet([
        { key: 'username', value: 'a', sensitive: false },
        { key: 'password', value: 'b', sensitive: true },
      ]).ok
    ).toBe(true)
  })

  it('mapCredentialSubmitError surfaces the conflicting key on a 409 field_key_conflict (AC-3)', () => {
    const mapped = mapCredentialSubmitError(
      new ApiClientError(
        409,
        { code: 'field_key_conflict' },
        'A field named "Username" already exists on this secret'
      )
    )
    expect(mapped.fieldKeyConflict).toBe('Username')
    expect(mapped.errorMessage).toMatch(/already exists/i)
  })
})
