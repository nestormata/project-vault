import { describe, expect, it } from 'vitest'
import {
  nonPromiseAuthStrategyFixture,
  txShapedWriteInputFixture,
  hmacCarryingWriteInputFixture,
  delegatedAliasFixture,
  delegatedHandlerFixture,
  delegatedWrapAliasFixture,
  legacyApiRouteHandlerFixture,
  legacyApiRouteWrapHandlerFixture,
  nonNarrowedDelegationFixture,
  nullableActorUserIdFixture,
} from './type-fixtures.js'

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

describe('Story 23.8 AC-2/AC-10 — AuditEventSourceWriteInput carries serializable data only', () => {
  it('exists purely to be typechecked — a Tx-shaped or hmac-carrying object must fail to satisfy AuditEventSourceWriteInput', () => {
    expect(txShapedWriteInputFixture).toBeDefined()
    expect(hmacCarryingWriteInputFixture).toBeDefined()
  })
})

describe('Story 71.8 AC-3/AC-4 — delegated context types (compile-time fixtures)', () => {
  it('exists purely to be typechecked: the legacy ctx union still fits, delegation needs the guard', () => {
    for (const fixture of [
      legacyApiRouteHandlerFixture,
      legacyApiRouteWrapHandlerFixture,
      delegatedHandlerFixture,
      delegatedAliasFixture,
      delegatedWrapAliasFixture,
      nonNarrowedDelegationFixture,
      nullableActorUserIdFixture,
    ]) {
      expect(fixture).toBeTypeOf('function')
    }
  })
})
