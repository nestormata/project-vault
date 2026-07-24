/**
 * AC5/AC6 — thrown synchronously by `registerExtension()` before `hooksFactory` is ever invoked.
 * Discriminated by `reason` so a caller (e.g. the Story 14.2 loader) can branch on the failure
 * cause without string-matching `message`.
 */
export type ExtensionRegistrationErrorReason = 'invalid-name' | 'incompatible-version'

export class ExtensionRegistrationError extends Error {
  readonly reason: ExtensionRegistrationErrorReason

  constructor(reason: ExtensionRegistrationErrorReason, message: string) {
    super(message)
    this.name = 'ExtensionRegistrationError'
    this.reason = reason
    Object.setPrototypeOf(this, ExtensionRegistrationError.prototype)
  }
}
