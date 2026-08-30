import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/svelte'
import ServiceStatusItem from './ServiceStatusItem.svelte'

afterEach(() => cleanup())

describe('ServiceStatusItem.svelte (Story 28.7 AC5/AC6/AC8)', () => {
  it('AC5: shows a single, non-contradictory pending state when lastCheckedAt is null, never the raw "healthy" badge', () => {
    const { getByText, queryByText } = render(ServiceStatusItem, {
      props: { name: 'API', status: 'healthy', lastCheckedAt: null },
    })

    expect(getByText('Not checked yet')).toBeTruthy()
    expect(getByText(/pending first check/i)).toBeTruthy()
    // The bug being fixed: a raw 'healthy' badge must never render alongside "Not checked yet".
    expect(queryByText('healthy')).toBeNull()
  })

  it('AC8: once lastCheckedAt is set, renders the real checked-at time and the real status badge (post-check behavior unchanged)', () => {
    const { getByText, queryByText } = render(ServiceStatusItem, {
      props: { name: 'API', status: 'healthy', lastCheckedAt: '2026-08-28T00:00:00.000Z' },
    })

    expect(queryByText('Not checked yet')).toBeNull()
    expect(queryByText(/pending first check/i)).toBeNull()
    expect(getByText('healthy')).toBeTruthy()
  })

  it('AC8: a real degraded/down outcome after a check still renders unchanged', () => {
    const { getByText } = render(ServiceStatusItem, {
      props: { name: 'API', status: 'down', lastCheckedAt: '2026-08-28T00:00:00.000Z' },
    })

    expect(getByText('down')).toBeTruthy()
  })
})
