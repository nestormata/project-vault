import { validateDateRange } from './date-range.js'

export function buildSearchSubmitHandler(
  setError: (err: string | null) => void
): (event: SubmitEvent) => void {
  return (event: SubmitEvent) => {
    const form = event.currentTarget as HTMLFormElement
    const formData = new FormData(form)
    const error = validateDateRange(
      String(formData.get('from') ?? ''),
      String(formData.get('to') ?? '')
    )
    if (error) {
      event.preventDefault()
      setError(error)
      return
    }
    setError(null)
  }
}
