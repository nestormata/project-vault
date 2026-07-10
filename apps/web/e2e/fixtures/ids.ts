import { randomUUID } from 'node:crypto'

// AC-I3: every spec creates its own uniquely-named org/user/project — matching this codebase's
// own collision-avoidance convention (see allocateOrganizationSlug) — no spec ever reads or
// depends on data created by another spec, and no "admin"/"seed" user is shared across specs.

export function uniqueEmail(prefix = 'e2e'): string {
  return `${prefix}-${randomUUID()}@example.com`
}

export function uniqueOrgName(prefix = 'E2E Org'): string {
  return `${prefix} ${randomUUID()}`
}

export function uniqueProjectName(prefix = 'E2E Project'): string {
  return `${prefix} ${randomUUID()}`
}

// AC-J1-1: a value the test can assert round-trips character-for-character through the real
// encrypt/store/decrypt/reveal path.
export function uniqueCredentialValue(prefix = 'e2e-test-value'): string {
  return `${prefix}-${randomUUID()}`
}
