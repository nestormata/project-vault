import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { getDb } from '@project-vault/db'
import { extensionRequestStates } from '@project-vault/db/schema'
import {
  burnPendingStateRow,
  generateOpaqueId,
  hashCookieValue,
  mintOpaqueCookieValue,
  peekPendingStateRow,
  ttlExpiresAtSql,
  validatePendingStateSize,
} from './extension-pending-state.js'

// Story 40.1 AC11 (rule-of-three extraction) — this suite exercises the shared mint/hash/burn/
// TTL-compare primitives directly against `extension_request_states` (the burn/peek queries are
// table-name-parameterized and reused verbatim by `oauth-handoff-routes.ts` against
// `extension_oauth_pending_states` — see that file's own 39.1 test suite for the burn-path
// coverage from the OTHER table's perspective).

const DEFAULT_EXTENSION_NAME = 'com.example.ext'
const DEFAULT_STATE_JSON = '{"selectionId":"abc123"}'

async function insertRow(overrides: {
  cookieHash: string
  orgId?: string
  identityId?: string
  consumedAt?: Date | null
  expiresAt?: Date
  stateJson?: string
}): Promise<void> {
  await getDb()
    .insert(extensionRequestStates)
    .values({
      id: generateOpaqueId(),
      cookieHash: overrides.cookieHash,
      extensionName: DEFAULT_EXTENSION_NAME,
      orgId: overrides.orgId ?? 'org-1',
      identityId: overrides.identityId ?? 'user-1',
      stateJson: overrides.stateJson ?? DEFAULT_STATE_JSON,
      consumedAt: overrides.consumedAt ?? null,
      expiresAt: overrides.expiresAt ?? new Date(Date.now() + 60_000),
    })
}

afterEach(async () => {
  await getDb().delete(extensionRequestStates)
})

describe('mintOpaqueCookieValue/generateOpaqueId/hashCookieValue', () => {
  it('mints distinct, non-empty opaque values and a stable, deterministic hash', () => {
    const a = mintOpaqueCookieValue()
    const b = mintOpaqueCookieValue()
    expect(a).not.toBe(b)
    expect(a.length).toBeGreaterThan(20)
    expect(generateOpaqueId()).not.toBe(generateOpaqueId())
    expect(hashCookieValue(a)).toBe(hashCookieValue(a))
    expect(hashCookieValue(a)).not.toBe(hashCookieValue(b))
  })
})

describe('validatePendingStateSize', () => {
  it('accepts a small, JSON-serializable payload', () => {
    expect(validatePendingStateSize({ a: 1 }, 4096)).toEqual({ ok: true })
  })

  it('rejects a payload over the byte cap', () => {
    expect(validatePendingStateSize({ big: 'x'.repeat(5000) }, 4096)).toEqual({
      ok: false,
      reason: 'too_large',
    })
  })

  it('rejects a circular-reference payload (Boundary Sweep — never lets JSON.stringify throw escape)', () => {
    const circular: Record<string, unknown> = {}
    circular['self'] = circular
    expect(validatePendingStateSize(circular, 4096)).toEqual({
      ok: false,
      reason: 'not_serializable',
    })
  })

  it('accepts an empty object (Boundary Sweep — {} must not be treated as absent)', () => {
    expect(validatePendingStateSize({}, 4096)).toEqual({ ok: true })
  })
})

describe('burnPendingStateRow / peekPendingStateRow (extension_request_states)', () => {
  it('peek returns the row without consuming it; a second peek still sees it (AC2 repeatable)', async () => {
    const cookieHash = hashCookieValue(randomUUID())
    await insertRow({ cookieHash })

    const first = await peekPendingStateRow('extension_request_states', cookieHash)
    const second = await peekPendingStateRow('extension_request_states', cookieHash)

    expect(first?.state_json).toBe(DEFAULT_STATE_JSON)
    expect(first?.consumed_at).toBeNull()
    expect(second?.state_json).toBe(DEFAULT_STATE_JSON)
  })

  it('burn atomically consumes the row; a second burn sees nothing (AC3 single-use)', async () => {
    const cookieHash = hashCookieValue(randomUUID())
    await insertRow({ cookieHash })

    const first = await burnPendingStateRow('extension_request_states', cookieHash)
    const second = await burnPendingStateRow('extension_request_states', cookieHash)

    expect(first?.state_json).toBe(DEFAULT_STATE_JSON)
    expect(second).toBeUndefined()

    // peek also stops seeing a consumed row (AC3)
    const peeked = await peekPendingStateRow('extension_request_states', cookieHash)
    expect(peeked).toBeUndefined()
  })

  it('peek/burn resolve undefined for an expired row (never treated as valid)', async () => {
    const cookieHash = hashCookieValue(randomUUID())
    await insertRow({ cookieHash, expiresAt: new Date(Date.now() - 1000) })

    expect(await peekPendingStateRow('extension_request_states', cookieHash)).toBeUndefined()
    expect(await burnPendingStateRow('extension_request_states', cookieHash)).toBeUndefined()
  })

  it('peek/burn resolve undefined for a garbage/tampered cookie hash (no matching row at all)', async () => {
    const cookieHash = hashCookieValue(randomUUID())
    expect(await peekPendingStateRow('extension_request_states', cookieHash)).toBeUndefined()
    expect(await burnPendingStateRow('extension_request_states', cookieHash)).toBeUndefined()
  })

  it('an extra AND condition (AC12 org/identity scoping) excludes a non-matching row from both peek and burn, without consuming it', async () => {
    const cookieHash = hashCookieValue(randomUUID())
    await insertRow({ cookieHash, orgId: 'org-A', identityId: 'user-X' })

    const wrongOrgCondition = sql`org_id = ${'org-B'}`
    expect(
      await peekPendingStateRow('extension_request_states', cookieHash, wrongOrgCondition)
    ).toBeUndefined()
    expect(
      await burnPendingStateRow('extension_request_states', cookieHash, wrongOrgCondition)
    ).toBeUndefined()

    // The row must be untouched (not burned) by the rejected cross-org attempt.
    const stillThere = await peekPendingStateRow('extension_request_states', cookieHash)
    expect(stillThere?.state_json).toBe(DEFAULT_STATE_JSON)
  })

  it('exact expiry-boundary instant (expires_at == now()) is treated as expired, never valid', async () => {
    const cookieHash = hashCookieValue(randomUUID())
    // expires_at set to the DB's own now() at insert time — by the time the SELECT/UPDATE below
    // runs, now() will have advanced past it, so this row is expired at or before the read.
    await getDb()
      .insert(extensionRequestStates)
      .values({
        id: generateOpaqueId(),
        cookieHash,
        extensionName: DEFAULT_EXTENSION_NAME,
        orgId: 'org-1',
        identityId: 'user-1',
        stateJson: '{}',
        expiresAt: sql`now()`,
      })

    expect(await peekPendingStateRow('extension_request_states', cookieHash)).toBeUndefined()
  })
})

describe('ttlExpiresAtSql', () => {
  it('produces an expiry roughly ttlMs in the future, computed by the database clock', async () => {
    const cookieHash = hashCookieValue(randomUUID())
    await getDb()
      .insert(extensionRequestStates)
      .values({
        id: generateOpaqueId(),
        cookieHash,
        extensionName: DEFAULT_EXTENSION_NAME,
        orgId: 'org-1',
        identityId: 'user-1',
        stateJson: '{}',
        expiresAt: ttlExpiresAtSql(60_000),
      })

    const row = await peekPendingStateRow('extension_request_states', cookieHash)
    expect(row).toBeDefined()
    const expiresAt = new Date(row?.expires_at as unknown as string)
    const deltaMs = expiresAt.getTime() - Date.now()
    expect(deltaMs).toBeGreaterThan(50_000)
    expect(deltaMs).toBeLessThan(70_000)
  })
})
