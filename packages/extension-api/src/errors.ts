/**
 * AC5/AC6 — thrown synchronously by `registerExtension()` before `hooksFactory` is ever invoked.
 * Discriminated by `reason` so a caller (e.g. the Story 14.2 loader) can branch on the failure
 * cause without string-matching `message`.
 */
/**
 * Story 23.2 AC-2 (findings F-H5/N16) — `'invalid-manifest-field'` is a distinct reason from
 * `'invalid-name'` and `'incompatible-version'`. It covers every `replacesNativeLogin`-shape
 * failure (non-boolean value, `true` without `'auth-provider'` in `capabilities[]`, `true`
 * without an `authStrategy` hook) and the case-fold near-miss unknown-key check. The host loader
 * (`apps/api/src/extensions/loader.ts`'s `mapFailureReason()`) maps this reason to the existing
 * public `'manifest_invalid'` `ExtensionLoadFailureReason` — no new value is added to that
 * enum, so Story 14.2's `/health` contract is unchanged.
 */
export type ExtensionRegistrationErrorReason =
  'invalid-name' | 'incompatible-version' | 'invalid-manifest-field' | 'invalid-db-scope'

// This union is intentionally open for future additions. Consumers should include a default
// branch when switching on reason; adding a member is a breaking public-contract change.

export class ExtensionRegistrationError extends Error {
  readonly reason: ExtensionRegistrationErrorReason

  constructor(reason: ExtensionRegistrationErrorReason, message: string) {
    super(message)
    this.name = 'ExtensionRegistrationError'
    this.reason = reason
    Object.setPrototypeOf(this, ExtensionRegistrationError.prototype)
  }
}
