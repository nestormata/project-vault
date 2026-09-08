import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  CreateOrgSsoDomainRequestSchema,
  isValidDomainLabel,
  normalizeSsoDomain,
  ORG_SSO_DOMAIN_ERROR_CODES,
  OrgSsoDomainListResponseSchema,
  OrgSsoDomainParamsSchema,
  OrgSsoDomainResponseSchema,
  UpdateOrgSsoDomainRequestSchema,
} from './org-sso-domains.js'

const TEST_PROVIDER = 'test.mock-sso-extension'

describe('org sso domain schemas (Story 14.6)', () => {
  it('normalizeSsoDomain lowercases and strips a single trailing FQDN dot', () => {
    expect(normalizeSsoDomain('ACME.com')).toBe('acme.com')
    expect(normalizeSsoDomain('gmail.com.')).toBe('gmail.com')
    expect(normalizeSsoDomain('gmail.com')).toBe('gmail.com')
  })

  it('isValidDomainLabel rejects @, whitespace, wildcards, and leading/trailing dots', () => {
    expect(isValidDomainLabel('acme.com')).toBe(true)
    expect(isValidDomainLabel('user@acme.com')).toBe(false)
    expect(isValidDomainLabel('acme .com')).toBe(false)
    expect(isValidDomainLabel('*.acme.com')).toBe(false)
    expect(isValidDomainLabel('.acme.com')).toBe(false)
    expect(isValidDomainLabel('acme.com.')).toBe(false)
    expect(isValidDomainLabel('')).toBe(false)
  })

  it('ORG_SSO_DOMAIN_ERROR_CODES carries the five contract literals', () => {
    expect(Object.values(ORG_SSO_DOMAIN_ERROR_CODES).sort()).toEqual(
      [
        'domain_already_mapped',
        'invalid_domain_format',
        'provider_check_unavailable',
        'provider_not_registered',
        'public_domain_blocked',
      ].sort()
    )
  })

  it('CreateOrgSsoDomainRequestSchema normalizes domain and rejects a malformed one', () => {
    const parsed = CreateOrgSsoDomainRequestSchema.safeParse({
      domain: 'ACME.com.',
      providerName: TEST_PROVIDER,
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.domain).toBe('acme.com')

    expect(
      CreateOrgSsoDomainRequestSchema.safeParse({
        domain: 'not a domain',
        providerName: TEST_PROVIDER,
      }).success
    ).toBe(false)
    expect(CreateOrgSsoDomainRequestSchema.safeParse({ domain: 'acme.com' }).success).toBe(false)
  })

  it.each(['profesional.co.cr', 'example.co.uk', 'example.com.br'])(
    'accepts a legitimate multi-label domain: %s',
    (domain) => {
      const parsed = CreateOrgSsoDomainRequestSchema.safeParse({
        domain,
        providerName: TEST_PROVIDER,
      })

      expect(parsed.success).toBe(true)
      if (parsed.success) expect(parsed.data.domain).toBe(domain)
    }
  )

  it('keeps the domain edge-case contract explicit', () => {
    expect(
      CreateOrgSsoDomainRequestSchema.safeParse({
        domain: 'intranet',
        providerName: TEST_PROVIDER,
      }).success
    ).toBe(true)

    const trailingDot = CreateOrgSsoDomainRequestSchema.safeParse({
      domain: 'Example.Co.Uk.',
      providerName: TEST_PROVIDER,
    })
    expect(trailingDot.success).toBe(true)
    if (trailingDot.success) expect(trailingDot.data.domain).toBe('example.co.uk')

    expect(
      CreateOrgSsoDomainRequestSchema.safeParse({
        domain: 'invalid domain',
        providerName: TEST_PROVIDER,
      }).success
    ).toBe(false)
  })

  it('UpdateOrgSsoDomainRequestSchema allows either field independently', () => {
    expect(UpdateOrgSsoDomainRequestSchema.safeParse({ domain: 'acme.com' }).success).toBe(true)
    expect(UpdateOrgSsoDomainRequestSchema.safeParse({ providerName: TEST_PROVIDER }).success).toBe(
      true
    )
    expect(UpdateOrgSsoDomainRequestSchema.safeParse({}).success).toBe(false)
  })

  it('OrgSsoDomainParamsSchema requires a uuid id', () => {
    expect(OrgSsoDomainParamsSchema.safeParse({ id: randomUUID() }).success).toBe(true)
    expect(OrgSsoDomainParamsSchema.safeParse({ id: 'not-a-uuid' }).success).toBe(false)
  })

  it('OrgSsoDomainResponseSchema/List validate a full row shape', () => {
    const row = {
      id: randomUUID(),
      domain: 'acme.com',
      providerName: TEST_PROVIDER,
      createdAt: '2026-07-27T12:00:00.000Z',
    }
    expect(OrgSsoDomainResponseSchema.safeParse(row).success).toBe(true)
    expect(OrgSsoDomainListResponseSchema.safeParse([row]).success).toBe(true)
  })
})
