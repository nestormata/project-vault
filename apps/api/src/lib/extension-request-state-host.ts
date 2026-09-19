import type { ExtensionRequestStateHostService } from '@project-vault/extension-api'
import { getRequestContext } from './request-context.js'
import { consumeRequestState } from './extension-request-state.js'

/**
 * Story 40.1 — the concrete implementation of `HostServices.extensionRequestState`, wired once
 * at extension-load time by `apps/api/src/extensions/loader.ts`'s `buildHostServices()`, mirroring
 * `ephemeral-state.ts`'s `createEphemeralStateHost()` shape exactly: bound once per loaded
 * extension, every method resolves the current request's ambient context via
 * `getRequestContext()` at call time rather than being reconstructed per request.
 */
export function createExtensionRequestStateHost(
  manifestName: string
): ExtensionRequestStateHostService {
  return {
    async consume() {
      const context = getRequestContext()
      // AC4/AC12 — no ambient request context bound (e.g. called outside any request lifecycle,
      // or on a request kind that never binds `extensionRequestStateCookie` — see
      // `RequestContext`'s own doc comment) resolves to `undefined`, never throws. Mirrors this
      // story's own generic-collapse discipline: a caller cannot distinguish "no context" from
      // "no cookie" from "wrong org" from "already consumed".
      if (!context) return undefined
      return consumeRequestState(context.extensionRequestStateCookie, {
        extensionName: manifestName,
        orgId: context.orgId,
        identityId: context.userId,
      })
    },
  }
}
