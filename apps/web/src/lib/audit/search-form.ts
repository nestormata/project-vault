import { validateDateRange } from './date-range.js'

export function buildSearchSubmitHandler(
  setError: (err: string | null) => void
): (event: SubmitEvent) => void {
  return (event: SubmitEvent) => {
    const form = event.currentTarget as HTMLFormElement
    const formData = new FormData(form)
    const fromValue = formData.get('from')
    const toValue = formData.get('to')
    const error = validateDateRange(
      typeof fromValue === 'string' ? fromValue : '',
      typeof toValue === 'string' ? toValue : ''
    )
    if (error) {
      event.preventDefault()
      setError(error)
      return
    }
    setError(null)
  }
}
