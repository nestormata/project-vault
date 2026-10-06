import { m } from '$lib/paraglide/messages.js'
import { validateDateRange } from './date-range.js'

export function buildSearchSubmitHandler(
  setError: (err: string | null) => void
): (event: SubmitEvent) => void {
  return (event: SubmitEvent) => {
    const form = event.currentTarget as HTMLFormElement
    const formData = new FormData(form)
    const fromValue = formData.get('from')
    const toValue = formData.get('to')
    const error =
      validateDateRange(
        typeof fromValue === 'string' ? fromValue : '',
        typeof toValue === 'string' ? toValue : ''
      ) ?? validateActorPair(formData.get('actorProvider'), formData.get('actorSubject'))
    if (error) {
      event.preventDefault()
      setError(error)
      return
    }
    setError(null)
  }
}

/** Story 71.10 D3: the external-actor filter is a PAIR; one alone would 422 on the server. */
function validateActorPair(
  provider: FormDataEntryValue | null,
  subject: FormDataEntryValue | null
) {
  const hasProvider = typeof provider === 'string' && provider.trim() !== ''
  const hasSubject = typeof subject === 'string' && subject.trim() !== ''
  return hasProvider === hasSubject ? null : m.audit_filter_actor_pair_required()
}
