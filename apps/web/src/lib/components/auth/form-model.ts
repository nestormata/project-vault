import { lookupSsoDomain } from '$lib/api/auth.js'
import type {
  AuthSessionResponse,
  DomainLookupRequest,
  DomainLookupResponse,
  LoginRequest,
  MfaLoginChallenge,
  RegisterRequest,
  VerifyMfaLoginRequest,
} from '$lib/api/auth.js'

export function buildRegisterRequest(fields: RegisterRequest): RegisterRequest {
  return fields.invitationToken
    ? { email: fields.email, password: fields.password, invitationToken: fields.invitationToken }
    : { email: fields.email, password: fields.password, orgName: fields.orgName }
}

export function clearRegisterFields(_fields: RegisterRequest): RegisterRequest {
  return { email: '', password: '', orgName: '' }
}

export function getPostRegisterPath(invitedProject?: { projectId: string }): string {
  return invitedProject ? `/projects/${invitedProject.projectId}` : '/login?reason=registered'
}

export function buildLoginRequest(fields: LoginRequest): LoginRequest {
  return { email: fields.email, password: fields.password }
}

export function clearLoginFields(_fields: LoginRequest): LoginRequest {
  return { email: '', password: '' }
}

export function isMfaChallenge(
  response: AuthSessionResponse | MfaLoginChallenge
): response is MfaLoginChallenge {
  return 'mfaRequired' in response && response.mfaRequired === true
}

export function buildMfaLoginRequest(fields: VerifyMfaLoginRequest): VerifyMfaLoginRequest {
  return { mfaToken: fields.mfaToken, totp: fields.totp }
}

export function clearMfaLoginFields(_fields: VerifyMfaLoginRequest): VerifyMfaLoginRequest {
  return { mfaToken: '', totp: '' }
}

// Story 14.4 Task 3.2/AC-2a: the client sends the raw email exactly as typed — the server (not
// this helper) is the source of truth for domain extraction/validation (Task 2.2), so this never
// attempts to pre-validate or extract a domain client-side.
export function buildDomainLookupRequest(email: string): DomainLookupRequest {
  return { email }
}

// Story 14.4 AC-1: a single, named predicate for "the lookup says this email routes to SSO" —
// used both to decide which step to render and to guard the out-of-order-response race (AC-8).
export function isSsoRequired(
  response: DomainLookupResponse
): response is { ssoRequired: true; providerName: string } {
  return response.ssoRequired === true && typeof response.providerName === 'string'
}

export type PreAuthThemeResolution = { name: string | null; css: string | null }

// Story 16.4 AC-3's both-or-neither invariant, extracted into one place: `theme` is
// absent/null on every miss/orphan/error path, so this always normalizes to a concrete
// { name, css } pair — never a partial theme. Shared by `resolvePreAuthTheme` below and by
// `LoginForm.svelte`'s own resolver (Story 16.5 Task 0), which needs the raw `DomainLookupResponse`
// too (to decide the SSO vs. password step) and so cannot call `resolvePreAuthTheme` end-to-end
// without doubling its one domain-lookup call per submission.
export function normalizePreAuthTheme(response: DomainLookupResponse): PreAuthThemeResolution {
  return { name: response.theme?.name ?? null, css: response.theme?.css ?? null }
}

// Story 16.5 Task 0: the single shared "what does a lookup resolve to, and what does a failure
// normalize to" implementation for the two new read-only call sites this story adds
// (`RegisterForm.svelte`'s blur/mount triggers, `invitations/accept/+page.svelte`'s
// peek-resolution trigger) — both only ever need the resolved theme, never the raw
// `ssoRequired`/`providerName` fields, so this wraps the fetch itself. Deliberately does NOT own
// any race-guard state (Svelte `$state` isn't portably shareable across component boundaries as a
// return value) — each caller keeps its own local in-flight-email tracking and discards a stale
// response by comparing against the current email after this resolves.
export async function resolvePreAuthTheme(
  fetchFn: typeof fetch,
  candidateEmail: string
): Promise<PreAuthThemeResolution> {
  try {
    return normalizePreAuthTheme(await lookupSsoDomain(fetchFn, candidateEmail))
  } catch {
    return { name: null, css: null }
  }
}
