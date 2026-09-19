import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDb } from '@project-vault/db'
import { extensionRequestStates } from '@project-vault/db/schema'
import type { FastifyReply } from 'fastify'
import {
  MAX_PERSIST_STATE_SIZE_BYTES,
  REQUEST_STATE_COOKIE_NAME,
  REQUEST_STATE_COOKIE_PATH,
  REQUEST_STATE_TTL_MS,
  consumeRequestState,
  mintRequestStateAndCookie,
  peekRequestState,
} from './extension-request-state.js'
import { hashCookieValue } from './extension-pending-state.js'

const SCOPE = { extensionName: 'com.example.ext', orgId: 'org-1', identityId: 'user-1' }

function fakeReply(): FastifyReply & { setCookie: ReturnType<typeof vi.fn> } {
  return { setCookie: vi.fn() } as unknown as FastifyReply & { setCookie: ReturnType<typeof vi.fn> }
}

afterEach(async () => {
  await getDb().delete(extensionRequestStates)
})

describe('mintRequestStateAndCookie (AC1/AC6)', () => {
  it('inserts a row and sets the cookie on success', async () => {
    const reply = fakeReply()
    const outcome = await mintRequestStateAndCookie(reply, {
      ...SCOPE,
      persistState: { selectionId: 'abc123' },
    })
    expect(outcome).toEqual({ ok: true })
    expect(reply.setCookie).toHaveBeenCalledWith(
      REQUEST_STATE_COOKIE_NAME,
      expect.any(String),
      expect.objectContaining({
        httpOnly: true,
        sameSite: 'lax',
        path: REQUEST_STATE_COOKIE_PATH,
        maxAge: REQUEST_STATE_TTL_MS / 1000,
      })
    )

    const rawCookie = (reply.setCookie.mock.calls[0] as unknown as [string, string])[1]
    const state = await peekRequestState(rawCookie, SCOPE)
    expect(state).toEqual({ selectionId: 'abc123' })
  })

  it('rejects an oversized persistState without setting a cookie (AC6)', async () => {
    const reply = fakeReply()
    const outcome = await mintRequestStateAndCookie(reply, {
      ...SCOPE,
      persistState: { big: 'x'.repeat(MAX_PERSIST_STATE_SIZE_BYTES + 1) },
    })
    expect(outcome).toEqual({ ok: false, reason: 'too_large' })
    expect(reply.setCookie).not.toHaveBeenCalled()
  })

  it('rejects a non-serializable persistState without setting a cookie (Boundary Sweep)', async () => {
    const reply = fakeReply()
    const circular: Record<string, unknown> = {}
    circular['self'] = circular
    const outcome = await mintRequestStateAndCookie(reply, { ...SCOPE, persistState: circular })
    expect(outcome).toEqual({ ok: false, reason: 'not_serializable' })
    expect(reply.setCookie).not.toHaveBeenCalled()
  })

  it('mints a cookie for an empty persistState object (Boundary Sweep — {} is not absent)', async () => {
    const reply = fakeReply()
    const outcome = await mintRequestStateAndCookie(reply, { ...SCOPE, persistState: {} })
    expect(outcome).toEqual({ ok: true })
    const rawCookie = (reply.setCookie.mock.calls[0] as unknown as [string, string])[1]
    expect(await peekRequestState(rawCookie, SCOPE)).toEqual({})
  })
})

describe('peekRequestState (AC2/AC4/AC12)', () => {
  it('returns undefined when there is no cookie', async () => {
    expect(await peekRequestState(undefined, SCOPE)).toBeUndefined()
  })

  it('returns undefined for a cookie that hashes to no row (tampered/garbage cookie, AC4)', async () => {
    expect(await peekRequestState(randomUUID(), SCOPE)).toBeUndefined()
  })

  it('does not consume the row — repeatable across multiple peeks (AC2)', async () => {
    const reply = fakeReply()
    await mintRequestStateAndCookie(reply, { ...SCOPE, persistState: { x: 1 } })
    const rawCookie = (reply.setCookie.mock.calls[0] as unknown as [string, string])[1]

    expect(await peekRequestState(rawCookie, SCOPE)).toEqual({ x: 1 })
    expect(await peekRequestState(rawCookie, SCOPE)).toEqual({ x: 1 })
  })

  it('AC12 — resolves undefined when orgId does not match the minting org, even with a valid cookie', async () => {
    const reply = fakeReply()
    await mintRequestStateAndCookie(reply, { ...SCOPE, persistState: { x: 1 } })
    const rawCookie = (reply.setCookie.mock.calls[0] as unknown as [string, string])[1]

    expect(await peekRequestState(rawCookie, { ...SCOPE, orgId: 'org-B' })).toBeUndefined()
  })

  it('AC12 — resolves undefined when identityId does not match, within the same org', async () => {
    const reply = fakeReply()
    await mintRequestStateAndCookie(reply, { ...SCOPE, persistState: { x: 1 } })
    const rawCookie = (reply.setCookie.mock.calls[0] as unknown as [string, string])[1]

    expect(await peekRequestState(rawCookie, { ...SCOPE, identityId: 'user-Y' })).toBeUndefined()
  })

  it('Boundary Sweep — extension disabled/uninstalled mid-journey fails closed (extension_name mismatch)', async () => {
    const reply = fakeReply()
    await mintRequestStateAndCookie(reply, { ...SCOPE, persistState: { x: 1 } })
    const rawCookie = (reply.setCookie.mock.calls[0] as unknown as [string, string])[1]

    expect(
      await peekRequestState(rawCookie, { ...SCOPE, extensionName: 'com.other.ext' })
    ).toBeUndefined()
  })
})

describe('consumeRequestState (AC3/AC4/AC12)', () => {
  it('returns undefined when there is no cookie', async () => {
    expect(await consumeRequestState(undefined, SCOPE)).toBeUndefined()
  })

  it('burns the row exactly once — a second consume returns undefined, and a subsequent peek also sees nothing (AC3)', async () => {
    const reply = fakeReply()
    await mintRequestStateAndCookie(reply, { ...SCOPE, persistState: { x: 1 } })
    const rawCookie = (reply.setCookie.mock.calls[0] as unknown as [string, string])[1]

    expect(await consumeRequestState(rawCookie, SCOPE)).toEqual({ x: 1 })
    expect(await consumeRequestState(rawCookie, SCOPE)).toBeUndefined()
    expect(await peekRequestState(rawCookie, SCOPE)).toBeUndefined()
  })

  it('AC12 — a cross-org consume attempt resolves undefined AND does not burn the row for the legitimate org', async () => {
    const reply = fakeReply()
    await mintRequestStateAndCookie(reply, { ...SCOPE, persistState: { x: 1 } })
    const rawCookie = (reply.setCookie.mock.calls[0] as unknown as [string, string])[1]

    const crossOrgAttempt = await consumeRequestState(rawCookie, { ...SCOPE, orgId: 'org-B' })
    expect(crossOrgAttempt).toBeUndefined()

    // The row must still be intact and consumable by the legitimate org.
    const legitimate = await consumeRequestState(rawCookie, SCOPE)
    expect(legitimate).toEqual({ x: 1 })
  })

  it('AC12 — a cross-identity consume attempt (same org) resolves undefined and does not burn the row', async () => {
    const reply = fakeReply()
    await mintRequestStateAndCookie(reply, { ...SCOPE, persistState: { x: 1 } })
    const rawCookie = (reply.setCookie.mock.calls[0] as unknown as [string, string])[1]

    expect(await consumeRequestState(rawCookie, { ...SCOPE, identityId: 'user-Y' })).toBeUndefined()
    expect(await consumeRequestState(rawCookie, SCOPE)).toEqual({ x: 1 })
  })
})

describe('cookie name (AC7)', () => {
  it('REQUEST_STATE_COOKIE_NAME is not oauth-handoff-pending, and hashing is stable', () => {
    expect(REQUEST_STATE_COOKIE_NAME).toBe('extension-request-state')
    expect(REQUEST_STATE_COOKIE_NAME).not.toBe('oauth-handoff-pending')
    expect(hashCookieValue('x')).toBe(hashCookieValue('x'))
  })
})
