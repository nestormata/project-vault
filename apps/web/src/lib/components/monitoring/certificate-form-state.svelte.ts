// The certificate create and edit forms bind to the exact same shape of local reactive state —
// this class is the one place that's declared, per Svelte 5's documented pattern for sharing
// $state across components (https://svelte.dev/docs/svelte/state-management).
export class CertificateFormState {
  domain = $state('')
  expiresAt = $state('')
  alertLeadDays = $state('')
  submitting = $state(false)
  errorMessage = $state<string | null>(null)
  fieldErrors = $state<{ domain?: string; expiresAt?: string }>({})
}
