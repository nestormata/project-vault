import type { AuthResult, AuthStrategy } from './auth-strategy.js'

/**
 * Compile-only fixture (AC3): proves `onAuthenticate` must return `Promise<AuthResult>`, not a
 * bare `AuthResult`. If a future change loosens the hook interface to allow a non-Promise return
 * value, the `@ts-expect-error` directive below stops suppressing a real type error and
 * `tsc --noEmit` fails instead with "Unused '@ts-expect-error' directive" — turning a silent
 * interface regression into a build failure (verified via `pnpm turbo typecheck` / `make ci`).
 *
 * Never invoked at runtime; exists only to be typechecked. The co-located `.test.ts` merely
 * proves this module loads without error — the actual assertion is the `@ts-expect-error` line
 * itself failing to compile without a real error to suppress.
 */
export const nonPromiseAuthStrategyFixture: AuthStrategy = {
  // @ts-expect-error — onAuthenticate must return Promise<AuthResult>, not a bare AuthResult
  onAuthenticate: (): AuthResult => ({
    externalSubject: 'fixture-subject',
    providerName: 'fixture-provider',
  }),
}
