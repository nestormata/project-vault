import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FastifyReply } from 'fastify'
import { getDb } from '@project-vault/db'
import { extensionRequestStates } from '@project-vault/db/schema'
import { createExtensionRequestStateHost } from './extension-request-state-host.js'
import { mintRequestStateAndCookie } from './extension-request-state.js'
import { runWithRequestContext } from './request-context.js'

const MANIFEST_NAME = 'com.example.ext'

function fakeReply(): FastifyReply & { setCookie: ReturnType<typeof vi.fn> } {
  return { setCookie: vi.fn() } as unknown as FastifyReply & { setCookie: ReturnType<typeof vi.fn> }
}

afterEach(async () => {
  await getDb().delete(extensionRequestStates)
})

describe('createExtensionRequestStateHost — HostServices.extensionRequestState.consume() (Story 40.1 AC3/AC4/AC12)', () => {
  it('resolves undefined when no ambient request context is bound at all (AC4)', async () => {
    const host = createExtensionRequestStateHost(MANIFEST_NAME)
    await expect(host.consume()).resolves.toBeUndefined()
  })

  it('resolves undefined when context is bound but carries no cookie (AC4)', async () => {
    const host = createExtensionRequestStateHost(MANIFEST_NAME)
    await runWithRequestContext({ orgId: 'org-1', userId: 'user-1' }, async () => {
      await expect(host.consume()).resolves.toBeUndefined()
    })
  })

  it('consumes the ambiently-bound cookie, scoped to the ambient orgId/userId', async () => {
    const reply = fakeReply()
    await mintRequestStateAndCookie(reply, {
      extensionName: MANIFEST_NAME,
      orgId: 'org-1',
      identityId: 'user-1',
      persistState: { selectionId: 'abc123' },
    })
    const rawCookie = (reply.setCookie.mock.calls[0] as unknown as [string, string])[1]

    const host = createExtensionRequestStateHost(MANIFEST_NAME)
    await runWithRequestContext(
      { orgId: 'org-1', userId: 'user-1', extensionRequestStateCookie: rawCookie },
      async () => {
        await expect(host.consume()).resolves.toEqual({ selectionId: 'abc123' })
        // Single-use — a second call in the same bound context returns undefined.
        await expect(host.consume()).resolves.toBeUndefined()
      }
    )
  })

  it('AC12 — a different ambiently-bound orgId cannot consume another org’s row', async () => {
    const reply = fakeReply()
    await mintRequestStateAndCookie(reply, {
      extensionName: MANIFEST_NAME,
      orgId: 'org-A',
      identityId: 'user-1',
      persistState: { selectionId: 'abc123' },
    })
    const rawCookie = (reply.setCookie.mock.calls[0] as unknown as [string, string])[1]

    const host = createExtensionRequestStateHost(MANIFEST_NAME)
    await runWithRequestContext(
      { orgId: 'org-B', userId: 'user-1', extensionRequestStateCookie: rawCookie },
      async () => {
        await expect(host.consume()).resolves.toBeUndefined()
      }
    )
  })
})
