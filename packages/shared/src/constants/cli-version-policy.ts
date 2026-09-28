/**
 * The limits the pvault CLI's policy validator enforces (packages/cli `semver-precedence.ts` and
 * `version-policy-response.ts`; a parity test there imports these through the API's
 * `@project-vault/api/client-version-policy` export). The CLI rejects the WHOLE policy when any
 * single value breaks them, which would silently stop withdrawals from being enforced — so the
 * server refuses to boot rather than serve such a policy.
 *
 * Story 43.13 AC-5 — defined once here so the API (`apps/api/src/modules/client-versions/policy.ts`
 * re-exports them) and the web /version page's all-or-nothing validator
 * (`apps/web/src/lib/api/client-version-policy-validate.ts`) cannot drift: raising a cap in only
 * one place would make the web page reject the whole policy while the server is healthy.
 */
export const CLI_MAX_VERSION_LENGTH = 128
export const CLI_MAX_WITHDRAWN_ENTRIES = 100
export const CLI_MAX_REASON_CODE_POINTS = 200
