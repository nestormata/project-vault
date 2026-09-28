// Story 60.4 (F10): every CentralizeMe-provisioned user gets a synthetic, undeliverable
// `users.email` on the RFC 2606 reserved `invalid` TLD. Construction and detection live together
// here so they can never drift apart. Dependency-free: this module also ships to the browser
// bundle (the /handoff consent page).

export const SERVICE_PROVISIONED_EMAIL_DOMAIN = 'invalid.projectvault'

const SERVICE_PROVISIONED_EMAIL_PATTERN = /^service-provisioned\+[^@\s]+@invalid\.projectvault$/i

export function serviceProvisionedEmail(id: string): string {
  return `service-provisioned+${id}@${SERVICE_PROVISIONED_EMAIL_DOMAIN}`
}

export function isServiceProvisionedEmail(email: string | null | undefined): boolean {
  if (typeof email !== 'string') return false
  return SERVICE_PROVISIONED_EMAIL_PATTERN.test(email)
}
