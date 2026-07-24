import { describe, expect, it } from 'vitest'
import { nonPromiseAuthStrategyFixture } from './type-fixtures.js'

describe('AC3 — Promise-typed hook methods (compile-time negative fixture)', () => {
  it('exists purely to be typechecked by `tsc --noEmit` (pnpm turbo typecheck / make ci)', () => {
    // The real assertion lives in type-fixtures.ts's `@ts-expect-error` comment: if a future
    // change loosens `AuthStrategy.onAuthenticate` to allow a non-Promise return value, that
    // directive stops suppressing a real error and becomes an "unused @ts-expect-error
    // directive" error instead — turning a silent interface regression into a build failure.
    // This runtime test only proves the fixture module itself loads without error.
    expect(nonPromiseAuthStrategyFixture).toBeDefined()
  })
})
