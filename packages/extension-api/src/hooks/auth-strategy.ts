/**
 * AC2/AC3 — `AuthStrategy` is one of the three typed hook interfaces this package exports. Its
 * return type carries only serializable data across the extension boundary (architecture.md
 * § Data Boundaries): no `Tx`, no `SecretValue`, no `AuthContext`. Runtime dispatch against a
 * real auth provider lands in Story 14.3 — this story only defines the contract shape.
 */
export type AuthResult = {
  /** Stable subject identifier from the external identity provider (e.g. a sub claim, user id). */
  externalSubject: string
  /** Identifies which provider produced this result (e.g. "okta", "github"). */
  providerName: string
  email?: string
  displayName?: string
}

export type AuthStrategy = {
  /**
   * Exchanges an opaque credential (e.g. an OAuth code, SAML assertion, bearer token) for an
   * `AuthResult`. Must return a `Promise` — see `hooks/type-fixtures.ts` for the negative
   * compile-time test proving a non-Promise-returning implementation fails typechecking (AC3).
   */
  onAuthenticate(credential: string): Promise<AuthResult>
}
