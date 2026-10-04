import { describe, expect, expectTypeOf, it } from 'vitest'
import type {
  ActionResult,
  ExtensionActionResult,
  ExtensionRequestContext,
  ModuleActionContext,
  OAuthHandoffHooks,
  OAuthHandoffRedirectResult,
  PublicRouteHooks,
  PublicRouteRequest,
  PublicRouteResult,
} from '../index.js'

// Story 68.11 AC-2 — type-level proofs (checked by `tsc --noEmit`, no suppression directives).
type HasKey<T, K extends string> = K extends keyof T ? true : false

describe('Story 68.11 AC-2 — neutral request types', () => {
  it('ExtensionRequestContext is the supertype of ModuleActionContext', () => {
    expectTypeOf<ModuleActionContext>().toMatchTypeOf<ExtensionRequestContext>()
  })

  it('ExtensionRequestContext carries no panel-only member', () => {
    expectTypeOf<HasKey<ExtensionRequestContext, 'slot'>>().toEqualTypeOf<false>()
    expectTypeOf<HasKey<ExtensionRequestContext, 'actionEndpoint'>>().toEqualTypeOf<false>()
    expectTypeOf<HasKey<ExtensionRequestContext, 'subpath'>>().toEqualTypeOf<false>()
  })

  it('ExtensionRequestContext keeps the request fields and the requestState peek', () => {
    expectTypeOf<HasKey<ExtensionRequestContext, 'identity'>>().toEqualTypeOf<true>()
    expectTypeOf<HasKey<ExtensionRequestContext, 'orgId'>>().toEqualTypeOf<true>()
    expectTypeOf<HasKey<ExtensionRequestContext, 'projectId'>>().toEqualTypeOf<true>()
    expectTypeOf<HasKey<ExtensionRequestContext, 'resourceId'>>().toEqualTypeOf<true>()
    expectTypeOf<HasKey<ExtensionRequestContext, 'locale'>>().toEqualTypeOf<true>()
    expectTypeOf<HasKey<ExtensionRequestContext, 'theme'>>().toEqualTypeOf<true>()
    expectTypeOf<ExtensionRequestContext['requestState']>().toEqualTypeOf<
      Record<string, unknown> | undefined
    >()
  })

  it('a literal missing orgId is not assignable to ExtensionRequestContext', () => {
    type MissingOrgId = Omit<ExtensionRequestContext, 'orgId'>
    expectTypeOf<MissingOrgId>().not.toMatchTypeOf<ExtensionRequestContext>()
  })

  it('ModuleActionContext keeps every panel-only member it had before', () => {
    expectTypeOf<ModuleActionContext['slot']>().toEqualTypeOf<string>()
    expectTypeOf<ModuleActionContext['actionEndpoint']>().toEqualTypeOf<string | undefined>()
    expectTypeOf<ModuleActionContext['subpath']>().toEqualTypeOf<string | undefined>()
  })

  it('ActionResult is the same type as ExtensionActionResult', () => {
    expectTypeOf<ActionResult>().toEqualTypeOf<ExtensionActionResult>()
  })

  it('an extension typed with the neutral names and one typed with the old names both compile', () => {
    const neutral: OAuthHandoffHooks = {
      async onOAuthStart(
        ctx: ExtensionRequestContext
      ): Promise<OAuthHandoffRedirectResult | ExtensionActionResult> {
        return ctx.orgId ? { outcome: 'ok' } : { outcome: 'denied' }
      },
      async onOAuthCallback() {
        return { outcome: 'ok' }
      },
    }
    const legacy: OAuthHandoffHooks = {
      async onOAuthStart(
        ctx: ModuleActionContext
      ): Promise<OAuthHandoffRedirectResult | ActionResult> {
        return ctx.slot ? { outcome: 'ok' } : { outcome: 'denied' }
      },
      async onOAuthCallback() {
        return { outcome: 'ok' }
      },
    }
    const publicRoute: PublicRouteHooks = {
      async onPublicRouteRequest(
        _request: PublicRouteRequest
      ): Promise<PublicRouteResult | ExtensionActionResult> {
        return { outcome: 'ok' }
      },
    }
    expect([neutral, legacy, publicRoute]).toHaveLength(3)
  })

  it('a neutral handler is assignable to the unchanged hook parameter type under strictFunctionTypes', () => {
    type StartProperty = {
      onOAuthStart: (ctx: ModuleActionContext) => Promise<ExtensionActionResult>
    }
    const handler = async (ctx: ExtensionRequestContext): Promise<ExtensionActionResult> =>
      ctx.orgId ? { outcome: 'ok' } : { outcome: 'denied' }
    const property: StartProperty = { onOAuthStart: handler }
    expect(property.onOAuthStart).toBe(handler)
  })
})
