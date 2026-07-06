// The service-endpoint create and edit forms bind to the exact same shape of local reactive
// state — this class is the one place that's declared, per Svelte 5's documented pattern for
// sharing $state across components (https://svelte.dev/docs/svelte/state-management). The edit
// form never populates `fieldErrors.url` (its URL field has no required-ness check), but sharing
// the wider type here costs nothing and keeps both forms on one declaration.
export class ServiceEndpointFormState {
  name = $state('')
  url = $state('')
  checkFrequencyMinutes = $state(5)
  downThresholdFailures = $state(2)
  submitting = $state(false)
  errorMessage = $state<string | null>(null)
  fieldErrors = $state<{ name?: string; url?: string }>({})
}
