import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { getDb } from '@project-vault/db'
import { handoffNonces } from '@project-vault/db/schema'
import { HandoffEvent } from '@project-vault/shared'
import {
  classifyJtiBurnError,
  consumeHandoffNonce,
  insertHandoffNonce,
} from './handoff-nonce-db.js'

process.env['DATABASE_URL'] ??=
  'postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault'

const FUTURE_MS = 120_000

function newHash(): string {
  return `test-nonce-hash-${randomUUID()}`
}

async function rowFor(nonceHash: string) {
  const [row] = await getDb()
    .select()
    .from(handoffNonces)
    .where(eq(handoffNonces.nonceHash, nonceHash))
  return row
}

describe('consumeHandoffNonce (Story 73.1 D5)', () => {
  it('consumes a live nonce once and records consumed_at', async () => {
    const nonceHash = newHash()
    await insertHandoffNonce(nonceHash, new Date(Date.now() + FUTURE_MS))

    expect(await consumeHandoffNonce(nonceHash)).toBe('consumed')
    expect((await rowFor(nonceHash))?.consumedAt).toBeInstanceOf(Date)
  })

  it('a second presentation of the same nonce is reused', async () => {
    const nonceHash = newHash()
    await insertHandoffNonce(nonceHash, new Date(Date.now() + FUTURE_MS))
    await consumeHandoffNonce(nonceHash)

    expect(await consumeHandoffNonce(nonceHash)).toBe('reused')
  })

  it('a nonce with no record is unknown', async () => {
    expect(await consumeHandoffNonce(newHash())).toBe('unknown')
  })

  it('an unconsumed nonce past expires_at is expired and stays unconsumed', async () => {
    const nonceHash = newHash()
    await insertHandoffNonce(nonceHash, new Date(Date.now() - 1000))

    expect(await consumeHandoffNonce(nonceHash)).toBe('expired')
    expect((await rowFor(nonceHash))?.consumedAt).toBeNull()
  })

  it('a consumed nonce that later expired is still reported as reused', async () => {
    const nonceHash = newHash()
    await insertHandoffNonce(nonceHash, new Date(Date.now() + FUTURE_MS))
    await consumeHandoffNonce(nonceHash)
    await getDb()
      .update(handoffNonces)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(handoffNonces.nonceHash, nonceHash))

    expect(await consumeHandoffNonce(nonceHash)).toBe('reused')
  })

  it('of two racing claims for one nonce exactly one consumes it', async () => {
    const nonceHash = newHash()
    await insertHandoffNonce(nonceHash, new Date(Date.now() + FUTURE_MS))

    const outcomes = await Promise.all([
      consumeHandoffNonce(nonceHash),
      consumeHandoffNonce(nonceHash),
    ])
    expect(outcomes.sort()).toEqual(['consumed', 'reused'])
  })
})

describe('classifyJtiBurnError', () => {
  it('a bare pg unique violation (23505) is a replay', () => {
    expect(classifyJtiBurnError({ code: '23505' })).toBe(HandoffEvent.HANDOFF_REPLAY)
  })

  it('a drizzle-wrapped unique violation (cause.code 23505) is a replay', () => {
    expect(classifyJtiBurnError({ cause: { code: '23505' } })).toBe(HandoffEvent.HANDOFF_REPLAY)
  })

  it.each([
    ['a connection failure (08006)', { code: '08006' }],
    ['a wrapped statement timeout (cause.code 57014)', { cause: { code: '57014' } }],
    ['a plain Error', new Error('connection reset')],
    ['a non-object throw', 'boom'],
    ['undefined', undefined],
    ['null', null],
  ])('%s maps to replay-store-unavailable', (_label, error) => {
    expect(classifyJtiBurnError(error)).toBe(HandoffEvent.HANDOFF_REPLAY_STORE_UNAVAILABLE)
  })
})
