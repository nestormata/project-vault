import { describe, expect, it, vi } from 'vitest'
import { buildPageHref } from './page-href.js'
import { buildSearchSubmitHandler } from './search-form.js'

describe('audit URL and search-form helpers', () => {
  it('builds page links from absent, empty, and populated filters', () => {
    expect(buildPageHref(null)(2)).toBe('?page=2')
    expect(buildPageHref(undefined)(1)).toBe('?page=1')
    expect(buildPageHref({ actor: 'user-1', eventType: '', resource: undefined })(3)).toBe(
      '?actor=user-1&page=3'
    )
  })

  it('allows valid ranges and clears a prior error', () => {
    const form = document.createElement('form')
    form.innerHTML =
      '<input name="from" value="2026-07-01" /><input name="to" value="2026-07-10" />'
    const setError = vi.fn()
    const event = new SubmitEvent('submit')
    Object.defineProperty(event, 'currentTarget', { value: form })
    buildSearchSubmitHandler(setError)(event)
    expect(event.defaultPrevented).toBe(false)
    expect(setError).toHaveBeenCalledWith(null)
  })

  it('supports non-string form values without treating an absent date as invalid', () => {
    const form = document.createElement('form')
    const from = document.createElement('input')
    from.type = 'file'
    from.name = 'from'
    Object.defineProperty(from, 'files', {
      value: [new File(['x'], 'from.txt')],
    })
    const to = document.createElement('input')
    to.name = 'to'
    to.value = '2026-07-01'
    form.append(from, to)
    const setError = vi.fn()
    const event = new SubmitEvent('submit', { cancelable: true })
    Object.defineProperty(event, 'currentTarget', { value: form })
    buildSearchSubmitHandler(setError)(event)
    expect(event.defaultPrevented).toBe(false)
    expect(setError).toHaveBeenCalledWith(null)
  })

  it('prevents an invalid date range', () => {
    const form = document.createElement('form')
    form.innerHTML =
      '<input name="from" value="2026-07-10" /><input name="to" value="2026-07-01" />'
    const setError = vi.fn()
    const event = new SubmitEvent('submit', { cancelable: true })
    Object.defineProperty(event, 'currentTarget', { value: form })
    buildSearchSubmitHandler(setError)(event)
    expect(event.defaultPrevented).toBe(true)
    expect(setError).toHaveBeenCalledWith('End date must be after start date')
  })
})
