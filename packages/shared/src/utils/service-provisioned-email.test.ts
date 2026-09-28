import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  SERVICE_PROVISIONED_EMAIL_DOMAIN,
  isServiceProvisionedEmail,
  serviceProvisionedEmail,
} from './service-provisioned-email.js'

// Story 60.4 AC1 (F10): the synthetic service-provisioned address must never reach the handoff
// consent screen. Construction (service-provisioning/service.ts) and detection (handoff prepare +
// the /handoff page) share this one module so they cannot drift apart.
describe('serviceProvisionedEmail', () => {
  it('builds the synthetic address on the reserved invalid.projectvault domain', () => {
    const id = randomUUID()
    expect(SERVICE_PROVISIONED_EMAIL_DOMAIN).toBe('invalid.projectvault')
    expect(serviceProvisionedEmail(id)).toBe(`service-provisioned+${id}@invalid.projectvault`)
  })

  it('round-trips: every constructed address is detected as synthetic', () => {
    expect(isServiceProvisionedEmail(serviceProvisionedEmail(randomUUID()))).toBe(true)
  })
})

describe('isServiceProvisionedEmail', () => {
  it.each([
    ['1.1 provisioning path (org id)', serviceProvisionedEmail(randomUUID())],
    ['1.2 org-member path (random UUID)', serviceProvisionedEmail(randomUUID())],
    ['1.4 upper-case variant', serviceProvisionedEmail('abc').toUpperCase()],
    ['1.4 mixed-case variant', serviceProvisionedEmail('abc').replace('service', 'Service')],
  ])('%s → synthetic', (_label, email) => {
    expect(isServiceProvisionedEmail(email)).toBe(true)
  })

  it.each([
    ['1.3 real email', 'alex@acme.com'],
    ['1.5 no +tag', 'service-provisioned@invalid.projectvault'],
    ['1.6 domain suffix', 'service-provisioned+x@invalid.projectvault.evil.com'],
    ['1.7 prefix not at start', 'alex+service-provisioned+x@invalid.projectvault'],
    ['1.8 other domain', 'service-provisioned+x@example.com'],
    ['whitespace in tag', 'service-provisioned+a b@invalid.projectvault'],
    ['second @ in tag', 'service-provisioned+a@b@invalid.projectvault'],
    ['trailing newline', 'service-provisioned+x@invalid.projectvault\n'],
  ])('%s → not synthetic', (_label, email) => {
    expect(isServiceProvisionedEmail(email)).toBe(false)
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty string', ''],
  ])('%s → false', (_label, email) => {
    expect(isServiceProvisionedEmail(email)).toBe(false)
  })
})
