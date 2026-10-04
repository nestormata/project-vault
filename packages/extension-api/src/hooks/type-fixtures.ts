import type { AuthResult, AuthStrategy } from './auth-strategy.js'
import type { CapabilityDecision, CapabilityGate } from './capability-gate.js'
import type { AuditEventSourceWriteInput } from './audit-event-source.js'
import { isApiRouteDelegatedContext } from './api-routes.js'
import type {
  ApiRouteContext,
  ApiRouteDelegatedHandler,
  ApiRouteDelegatedWrapHandler,
  ApiRouteHandler,
  ApiRouteOrgRole,
  ApiRoutePublicContext,
  ApiRouteReply,
  ApiRouteRequest,
  ApiRouteWrapHandler,
} from './api-routes.js'

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

/**
 * AC1 — mirrors the AuthStrategy fixture above: proves `onCheckCapability` must return
 * `Promise<CapabilityDecision>`, not a bare `CapabilityDecision`.
 */
export const nonPromiseCapabilityGateFixture: CapabilityGate = {
  // @ts-expect-error — onCheckCapability must return Promise<CapabilityDecision>, not a bare CapabilityDecision
  onCheckCapability: (): CapabilityDecision => ({ permitted: true }),
}

/**
 * Story 23.8 AC-2/AC-10 — proves the extension boundary carries serializable data only: a
 * `Tx`-shaped or `hmac`-carrying object must NOT satisfy `AuditEventSourceWriteInput`. If a
 * future change widens this type to accept either, the `@ts-expect-error` directives below stop
 * suppressing a real error and `tsc --noEmit` fails instead.
 */
export const txShapedWriteInputFixture: AuditEventSourceWriteInput = {
  eventType: 'ext.com.acme.fixture.event',
  orgId: 'fixture-org',
  payload: {},
  // @ts-expect-error — AuditEventSourceWriteInput must never accept a Tx/connection-shaped field
  tx: {},
}

export const hmacCarryingWriteInputFixture: AuditEventSourceWriteInput = {
  eventType: 'ext.com.acme.fixture.event',
  orgId: 'fixture-org',
  payload: {},
  // @ts-expect-error — AuditEventSourceWriteInput must never accept a keyVersion/hmac field
  keyVersion: 1,
  hmac: 'deadbeef',
}

/**
 * Story 71.8 AC-3/AC-4 — a handler annotated with the pre-71.8 context union must still be an
 * `ApiRouteHandler` / `ApiRouteWrapHandler` (the new `Ctx` type parameter defaults to that union),
 * so the minor release breaks no existing author. No `@ts-expect-error` here: it must compile.
 */
export const legacyApiRouteHandlerFixture: ApiRouteHandler = (
  ctx: ApiRouteContext | ApiRoutePublicContext,
  _req: ApiRouteRequest,
  _reply: ApiRouteReply
): unknown => ctx
export const legacyApiRouteWrapHandlerFixture: ApiRouteWrapHandler = (
  ctx: ApiRouteContext | ApiRoutePublicContext,
  _req: ApiRouteRequest,
  _reply: ApiRouteReply,
  next: () => Promise<unknown>
): unknown => [ctx, next]

/** A handler narrowing with the guard reads the delegated fields; `orgRole` may be absent. */
export const delegatedHandlerFixture: ApiRouteHandler = (ctx) => {
  if (!isApiRouteDelegatedContext(ctx)) return undefined
  const attestation: 'pv_verified' | 'issuer_attested' = ctx.delegation.actorAttestation
  const role: ApiRouteOrgRole | undefined = ctx.auth.orgRole
  const actorUserId: string | null = ctx.delegation.actorUserId
  const operator: false = ctx.auth.isPlatformOperator
  return [attestation, role, actorUserId, operator]
}

/** The delegated handler aliases receive the delegated context without narrowing. */
export const delegatedAliasFixture: ApiRouteDelegatedHandler = (ctx) => ctx.delegation.orgId
export const delegatedWrapAliasFixture: ApiRouteDelegatedWrapHandler = (
  ctx,
  _req,
  _reply,
  next
) => [ctx.auth.sessionId, next]

/** `ctx.delegation` is not readable on a non-narrowed context, and `actorUserId` can be null. */
export const nonNarrowedDelegationFixture: ApiRouteHandler = (ctx) =>
  // @ts-expect-error — `delegation` does not exist on ApiRouteContext | ApiRoutePublicContext
  ctx.delegation
export const nullableActorUserIdFixture: ApiRouteDelegatedHandler = (ctx) => {
  // @ts-expect-error — `actorUserId` is `string | null`, not assignable to `string`
  const userId: string = ctx.delegation.actorUserId
  return userId
}
