import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import AuditSearchForm from './AuditSearchForm.svelte'

const POINT_PROPS = { orgRole: 'owner', allowed: true } as never

afterEach(() => cleanup())

function renderForm(filters: Record<string, string> | undefined = undefined) {
  return render(AuditSearchForm, {
    props: { filters, hasFilters: Boolean(filters), pointProps: POINT_PROPS },
  })
}

describe('AuditSearchForm actor provider + subject filter (Story 71-10 AC-4)', () => {
  it('has labelled provider and subject inputs wired to the query params, with described-by help', () => {
    renderForm()
    const provider = screen.getByLabelText(/Actor provider/) as HTMLInputElement
    const subject = screen.getByLabelText(/Actor subject/) as HTMLInputElement
    expect(provider.name).toBe('actorProvider')
    expect(subject.name).toBe('actorSubject')
    for (const input of [provider, subject]) {
      const help = input.getAttribute('aria-describedby')
      expect(help).toBeTruthy()
      expect(document.getElementById(help ?? '')?.textContent?.length).toBeGreaterThan(0)
    }
  })

  it('pre-fills from the URL filters', () => {
    renderForm({ actorProvider: 'workos', actorSubject: 'user_01X' })
    expect((screen.getByLabelText(/Actor provider/) as HTMLInputElement).value).toBe('workos')
    expect((screen.getByLabelText(/Actor subject/) as HTMLInputElement).value).toBe('user_01X')
  })

  it('blocks submit and explains when only one of provider/subject is filled', async () => {
    const { container } = renderForm()
    await fireEvent.input(screen.getByLabelText(/Actor provider/), { target: { value: 'workos' } })
    const form = container.querySelector('form') as HTMLFormElement
    const notPrevented = fireEvent.submit(form)
    expect(await notPrevented).toBe(false)
    expect(screen.getByRole('alert').textContent).toMatch(
      /both the actor provider and the actor subject/i
    )
  })

  it('submits when both or neither are filled', async () => {
    const { container } = renderForm()
    const form = container.querySelector('form') as HTMLFormElement
    expect(await fireEvent.submit(form)).toBe(true)
    await fireEvent.input(screen.getByLabelText(/Actor provider/), { target: { value: 'workos' } })
    await fireEvent.input(screen.getByLabelText(/Actor subject/), { target: { value: 'u' } })
    expect(await fireEvent.submit(form)).toBe(true)
  })
})

// Story 63.2 AC-3: no audit search field may carry the generic boilerplate help text.
describe('AuditSearchForm per-field help (Story 63.2 AC-3)', () => {
  it.each([
    ['filter-eventType', /events of this type/i],
    ['filter-actorId', /user or machine identity/i],
    ['filter-resourceId', /resource/i],
    ['filter-projectId', /project/i],
  ])('%s has specific help, not the generic boilerplate', (id, pattern) => {
    renderForm()
    const input = document.getElementById(id) as HTMLInputElement
    const help = document.getElementById(input.getAttribute('aria-describedby') ?? '')
    expect(help?.textContent).toMatch(pattern)
    expect(help?.textContent).not.toContain(
      'Enter the value this setting uses. Review it before saving.'
    )
  })
})
