import { describe, expect, it, vi } from 'vitest'
import { buildSearchSubmitHandler } from './search-form.js'

function makeSubmitEvent(from: string, to: string): SubmitEvent {
  const form = document.createElement('form')
  const fromInput = document.createElement('input')
  fromInput.name = 'from'
  fromInput.value = from
  form.appendChild(fromInput)
  const toInput = document.createElement('input')
  toInput.name = 'to'
  toInput.value = to
  form.appendChild(toInput)

  return {
    currentTarget: form,
    preventDefault: vi.fn(),
  } as unknown as SubmitEvent
}

describe('buildSearchSubmitHandler', () => {
  it('blocks submission and reports the error when the range is invalid', () => {
    const setError = vi.fn()
    const handler = buildSearchSubmitHandler(setError)
    const event = makeSubmitEvent('2026-02-01', '2026-01-01')

    handler(event)

    expect(event.preventDefault).toHaveBeenCalled()
    expect(setError).toHaveBeenCalledWith('End date must be after start date')
  })

  it('clears the error and allows submission when the range is valid', () => {
    const setError = vi.fn()
    const handler = buildSearchSubmitHandler(setError)
    const event = makeSubmitEvent('2026-01-01', '2026-02-01')

    handler(event)

    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(setError).toHaveBeenCalledWith(null)
  })
})
