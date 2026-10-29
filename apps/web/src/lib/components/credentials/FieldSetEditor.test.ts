import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isMainField } from '$lib/credentials/credential-detail-helpers.js'
import {
  fieldDraftToRequest,
  type FieldDraft,
} from '$lib/components/onboarding/onboarding-logic.js'
import FieldSetEditor from './FieldSetEditor.svelte'

// Story 72.10 (P5): field kinds in the shared field-list editor.

afterEach(() => cleanup())

function mount(fields: FieldDraft[], multilineValue = false) {
  return render(FieldSetEditor, {
    props: { fields, multilineValue, onAdd: vi.fn(), onRemove: vi.fn() },
  })
}

describe('FieldSetEditor kinds (72-10)', () => {
  it('shows a textarea for a multiline field and a masked input for a sensitive text field', () => {
    mount([
      { key: 'private key', value: '', sensitive: true, kind: 'multiline' },
      { key: 'token', value: '', sensitive: true },
    ])
    const multiline = screen.getByLabelText('Field 1 value')
    const text = screen.getByLabelText('Field 2 value')
    expect(multiline.tagName).toBe('TEXTAREA')
    expect(text.tagName).toBe('INPUT')
    expect(text.getAttribute('type')).toBe('password')
  })

  it('switching a field to one-time password makes it sensitive', async () => {
    const draft: FieldDraft = { key: '2FA', value: '', sensitive: false }
    mount([draft])
    await fireEvent.change(screen.getByLabelText('Type 1'), { target: { value: 'totp' } })
    expect(draft).toMatchObject({ kind: 'totp', sensitive: true })
    await fireEvent.change(screen.getByLabelText('Type 1'), { target: { value: 'text' } })
    expect(draft.kind).toBeUndefined()
  })

  it('renders a one-time-password field as a locked, masked seed input', () => {
    mount([{ key: '2FA', value: '', sensitive: false, kind: 'totp' }])
    const box = screen.getByRole('checkbox') as HTMLInputElement
    expect(box.checked).toBe(true)
    expect(box.disabled).toBe(true)
    const seed = screen.getByLabelText('Field 1 value')
    expect(seed.getAttribute('type')).toBe('password')
    expect(seed.getAttribute('placeholder')).toBe('Seed or otpauth:// link')
  })

  it('tells the user a stored seed is kept when the box is left empty', () => {
    mount([{ key: '2FA', value: '', sensitive: true, kind: 'totp', storedSeed: true }])
    expect(screen.getByLabelText('Field 1 value').getAttribute('placeholder')).toBe(
      'Seed stored. Leave empty to keep it'
    )
  })

  it('every control has a visible description (form guidance)', () => {
    mount([{ key: 'a', value: '', sensitive: false }])
    for (const control of [
      ...screen.getAllByRole('textbox'),
      ...screen.getAllByRole('combobox'),
      ...screen.getAllByRole('checkbox'),
    ]) {
      const ids = (control.getAttribute('aria-describedby') ?? '').split(' ').filter(Boolean)
      expect(ids.length).toBeGreaterThan(0)
      for (const id of ids) expect(document.getElementById(id)?.textContent?.trim()).toBeTruthy()
    }
  })
})

describe('fieldDraftToRequest (72-10)', () => {
  it('sends a kind only when it is not the default, trims the key and forces totp sensitive', () => {
    expect(fieldDraftToRequest({ key: ' a ', value: 'v', sensitive: false })).toEqual({
      key: 'a',
      value: 'v',
      sensitive: false,
    })
    expect(
      fieldDraftToRequest({ key: 'n', value: 'v', sensitive: true, kind: 'multiline' })
    ).toEqual({ key: 'n', value: 'v', sensitive: true, kind: 'multiline' })
    expect(
      fieldDraftToRequest({
        key: '2FA',
        value: '',
        sensitive: false,
        kind: 'totp',
        storedSeed: true,
      })
    ).toEqual({ key: '2FA', value: '', sensitive: true, kind: 'totp' })
  })
})

describe('isMainField (72-10)', () => {
  it('matches the template main field case-insensitively and never a custom or template-less field', () => {
    expect(isMainField({ key: 'password', template: 'login' })).toBe(true)
    expect(isMainField({ key: 'Password', template: 'db_connection' })).toBe(true)
    expect(isMainField({ key: 'username', template: 'login' })).toBe(false)
    expect(isMainField({ key: 'password', template: 'custom' })).toBe(false)
    expect(isMainField({ key: 'password' })).toBe(false)
  })
})
