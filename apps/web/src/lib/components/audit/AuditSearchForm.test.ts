import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import AuditSearchForm from './AuditSearchForm.svelte'

afterEach(() => cleanup())

function renderForm(filters: Record<string, string> | undefined = undefined) {
  return render(AuditSearchForm, { props: { filters, hasFilters: Boolean(filters) } })
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
