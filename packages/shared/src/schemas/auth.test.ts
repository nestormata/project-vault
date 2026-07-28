import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  AdminRevokeSessionsResponseSchema,
  AuthSessionResponseSchema,
  CreateOrgSsoDomainRequestSchema,
  isValidDomainLabel,
  LoginRequestSchema,
  normalizeSsoDomain,
  ORG_SSO_DOMAIN_ERROR_CODES,
  OrgSsoDomainListResponseSchema,
  OrgSsoDomainParamsSchema,
  OrgSsoDomainResponseSchema,
  RegisterRequestSchema,
  RegisterResponseSchema,
  RevokeSessionsResponseSchema,
  SessionListResponseSchema,
  UpdateOrgSsoDomainRequestSchema,
} from './auth.js'

const OWNER_EMAIL = 'owner@example.com'
const PASSWORD = 'correct-horse-battery-staple'
const TEST_PROVIDER = 'test.mock-sso-extension'

describe('auth schemas', () => {
  it('validates register and login request contracts', () => {
    expect(
      RegisterRequestSchema.safeParse({
        email: OWNER_EMAIL,
        password: PASSWORD,
        orgName: 'Acme Corp',
      }).success
    ).toBe(true)
    expect(LoginRequestSchema.safeParse({ email: OWNER_EMAIL, password: 'x' }).success).toBe(true)
  })

  it('validates register request contracts for invitation-based joins (Story 4.1 D4)', () => {
    expect(
      RegisterRequestSchema.safeParse({
        email: OWNER_EMAIL,
        password: PASSWORD,
        invitationToken: 'opaque-token',
      }).success
    ).toBe(true)
    expect(
      RegisterRequestSchema.safeParse({
        email: OWNER_EMAIL,
        password: PASSWORD,
      }).success
    ).toBe(false)
  })

  it('validates auth response contracts', () => {
    const ids = {
      userId: randomUUID(),
      orgId: randomUUID(),
    }

    expect(
      AuthSessionResponseSchema.safeParse({ ...ids, expiresAt: '2026-06-24T12:05:00.000Z' }).success
    ).toBe(true)
    expect(
      RegisterResponseSchema.safeParse({
        ...ids,
        email: OWNER_EMAIL,
        orgName: 'Acme Corp',
        role: 'owner',
      }).success
    ).toBe(true)
    expect(
      RegisterResponseSchema.safeParse({
        ...ids,
        email: OWNER_EMAIL,
        orgName: 'Acme Corp',
        role: 'member',
        invitedProject: { projectId: randomUUID(), projectName: 'Payments API', role: 'admin' },
      }).success
    ).toBe(true)
  })

  it('validates session management response contracts', () => {
    const sessionId = randomUUID()
    const userId = randomUUID()

    expect(
      SessionListResponseSchema.safeParse([
        {
          sessionId,
          createdAt: '2026-06-24T12:00:00.000Z',
          lastActiveAt: '2026-06-24T12:05:00.000Z',
          ipAddress: '203.0.113.10',
          userAgent: 'vitest',
          isCurrent: true,
        },
      ]).success
    ).toBe(true)
    expect(RevokeSessionsResponseSchema.safeParse({ revokedCount: 0 }).success).toBe(true)
    expect(AdminRevokeSessionsResponseSchema.safeParse({ revokedCount: 2, userId }).success).toBe(
      true
    )
  })
})

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
