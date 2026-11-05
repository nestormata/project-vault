const ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ'

/** Story 43.30: the same user-code shape the API accepts, used to prefill the approval page. */
export function prefilledUserCode(raw: string | null): string {
  if (!raw) return ''
  const compact = raw.replace(/[\s-]/g, '').toUpperCase()
  if (compact.length !== 8) return ''
  for (const char of compact) {
    if (!ALPHABET.includes(char)) return ''
  }
  return `${compact.slice(0, 4)}-${compact.slice(4)}`
}

export function cliDeviceOutcomeMessageKey(
  code: string | undefined
):
  | 'cli_device_approved'
  | 'cli_device_denied'
  | 'cli_device_invalid_code'
  | 'cli_device_step_up_required'
  | 'cli_device_enrollment_required'
  | 'cli_device_error' {
  switch (code) {
    case 'approved':
      return 'cli_device_approved'
    case 'denied':
      return 'cli_device_denied'
    case 'invalid_user_code':
      return 'cli_device_invalid_code'
    case 'step_up_required':
      return 'cli_device_step_up_required'
    case 'totp_enrollment_required':
      return 'cli_device_enrollment_required'
    default:
      return 'cli_device_error'
  }
}
