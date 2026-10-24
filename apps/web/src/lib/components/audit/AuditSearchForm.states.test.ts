// @pv-not-guard oracle of PV's own un-composed markup, valid only on PV's tree
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import type { Component } from 'svelte'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { serializeWithoutNoise } from '$lib/test/dom.js'

// Story 69.12: the search form's client-driven states (the date-range error, the actor pair error,
// a corrected resubmit) and its server-driven filter variants. This pins them: the snapshot was
// recorded BEFORE the form was split into sub-regions and must come out unchanged.

vi.mock('$app/paths', () => ({ resolve: (path: string) => path }))

let Form: Component<Record<string, unknown>>
beforeAll(async () => {
  Form = (await import('./AuditSearchForm.svelte')).default as unknown as typeof Form
}, 60_000)
afterEach(cleanup)

const ALL_FILTERS = {
  eventType: 'credential.access',
  actorId: 'actor-9',
  actorProvider: 'cm',
  actorSubject: 'user-1',
  resourceId: 'cred-1',
  projectId: 'proj-1',
  from: '2026-10-01',
  to: '2026-10-31',
}
const asText = (states: Record<string, unknown>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(states).map(([key, value]) => [
      key,
      typeof value === 'string' ? value : JSON.stringify(value),
    ])
  )
const mount = (filters: Record<string, string> | undefined, hasFilters = Boolean(filters)) =>
  render(Form, { props: { filters, hasFilters } })
const formOf = (container: Element) => container.querySelector('form') as HTMLFormElement
const typeInto = (label: RegExp | string, value: string) =>
  fireEvent.input(screen.getByLabelText(label), { target: { value } })

describe('AuditSearchForm states (Story 69.12 pre-split pin)', () => {
  it('renders every state exactly as before the split', async () => {
    const states: Record<string, unknown> = {}

    const empty = mount(undefined)
    states['no-filters'] = serializeWithoutNoise(empty.container)
    cleanup()

    const full = mount(ALL_FILTERS)
    states['all-filters'] = serializeWithoutNoise(full.container)
    cleanup()

    const dated = mount({ from: '2026-10-01' })
    states['only-from'] = serializeWithoutNoise(dated.container)
    cleanup()

    const flagged = mount({}, true)
    states['has-filters-empty-summary'] = serializeWithoutNoise(flagged.container)
    cleanup()

    const range = mount(undefined)
    await typeInto('From', '2026-10-31')
    await typeInto('To', '2026-10-01')
    states['range-submit-prevented'] = await fireEvent.submit(formOf(range.container))
    states['range-error'] = serializeWithoutNoise(range.container)
    await typeInto('To', '2026-11-30')
    states['range-corrected-submit-allowed'] = await fireEvent.submit(formOf(range.container))
    states['range-corrected'] = serializeWithoutNoise(range.container)
    cleanup()

    const pair = mount(undefined)
    await typeInto(/Actor provider/, 'cm')
    states['pair-submit-prevented'] = await fireEvent.submit(formOf(pair.container))
    states['pair-error'] = serializeWithoutNoise(pair.container)
    cleanup()

    const children = render(Form, {
      props: { filters: undefined, hasFilters: false },
    })
    states['children-absent'] = serializeWithoutNoise(children.container)

    await expect(`${JSON.stringify(asText(states), null, 2)}\n`).toMatchFileSnapshot(
      './AuditSearchForm.states.snapshot.json'
    )
    expect(states['range-submit-prevented']).toBe(false)
  }, 60_000)
})
