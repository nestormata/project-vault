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

  it('reports matches=true on an exact match', async () => {
    const onMatchChange = vi.fn()
    render(TypedConfirmInput, {
      props: { expectedValue: 'jsmith@example.com', onMatchChange },
    })

    const input = screen.getByRole('textbox')
    await fireEvent.input(input, { target: { value: 'jsmith@example.com' } })

    expect(onMatchChange).toHaveBeenLastCalledWith(true)
  })

  it('is case-insensitive and trims whitespace (AC-D4 low-severity fix)', async () => {
    const onMatchChange = vi.fn()
    render(TypedConfirmInput, {
      props: { expectedValue: 'JSmith@Example.com', onMatchChange },
    })

    const input = screen.getByRole('textbox')
    await fireEvent.input(input, { target: { value: '  jsmith@example.com  ' } })

    expect(onMatchChange).toHaveBeenLastCalledWith(true)
  })

  it('reports matches=false for a typo/mismatch', async () => {
    const onMatchChange = vi.fn()
    render(TypedConfirmInput, {
      props: { expectedValue: 'jsmith@example.com', onMatchChange },
    })

    const input = screen.getByRole('textbox')
    await fireEvent.input(input, { target: { value: 'jsmit@example.com' } })

    expect(onMatchChange).toHaveBeenLastCalledWith(false)
  })
})
