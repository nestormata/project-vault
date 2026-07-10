import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import TypedConfirmInput from './TypedConfirmInput.svelte'

afterEach(() => cleanup())

// D4/D5 — the shared typed-identifier confirmation gate for pseudonymize (AC-J) and
// erasure-execute (AC-L). It renders no submit button itself; it only reports match state via
// onMatchChange so the parent can enable/disable its own control.
describe('TypedConfirmInput (D4/D5)', () => {
  it('reports matches=false while the input is empty', () => {
    const onMatchChange = vi.fn()
    render(TypedConfirmInput, {
      props: { expectedValue: 'jsmith@example.com', onMatchChange },
    })
    expect(onMatchChange).not.toHaveBeenCalledWith(true)
  })

  it.each([
    {
      name: 'an exact match',
      expectedValue: 'jsmith@example.com',
      typed: 'jsmith@example.com',
      expected: true,
    },
    {
      name: 'a case-insensitive, whitespace-trimmed match (AC-D4 low-severity fix)',
      expectedValue: 'JSmith@Example.com',
      typed: '  jsmith@example.com  ',
      expected: true,
    },
    {
      name: 'a typo/mismatch',
      expectedValue: 'jsmith@example.com',
      typed: 'jsmit@example.com',
      expected: false,
    },
  ])('reports matches=$expected for $name', async ({ expectedValue, typed, expected }) => {
    const onMatchChange = vi.fn()
    render(TypedConfirmInput, {
      props: { expectedValue, onMatchChange },
    })

    const input = screen.getByRole('textbox')
    await fireEvent.input(input, { target: { value: typed } })

    expect(onMatchChange).toHaveBeenLastCalledWith(expected)
  })
})
