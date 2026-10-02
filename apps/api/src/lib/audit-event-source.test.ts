import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EXTENSION_API_VERSION } from '@project-vault/extension-api'
import type { ExtensionManifest } from '@project-vault/extension-api'
import { SameTransactionAuditWriteError } from './secure-route.js'

const { writeExtensionAuditEntry } = vi.hoisted(() => ({
  writeExtensionAuditEntry: vi.fn(),
}))
vi.mock('../modules/audit/extension-entry.js', () => ({ writeExtensionAuditEntry }))

// Story 71.1: the dedupe logic lives in a sibling helper; only its WRITE function is mocked so the
// real key validation/error classes stay in play.
const { writeIdempotentExtensionAuditEntry } = vi.hoisted(() => ({
  writeIdempotentExtensionAuditEntry: vi.fn(),
}))
vi.mock('../modules/audit/extension-idempotency.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../modules/audit/extension-idempotency.js')>()),
  writeIdempotentExtensionAuditEntry,
}))

const { withOrg } = vi.hoisted(() => ({
  withOrg: vi.fn(async (_orgId: string, fn: (tx: unknown) => unknown) => fn({})),
}))
vi.mock('@project-vault/db', () => ({ withOrg }))

import {
  ExtensionAuditCapabilityNotDeclaredError,
  ExtensionAuditEventTypeNamespaceError,
  ExtensionAuditIdempotencyConflictError,
  ExtensionAuditIdempotencyKeyInvalidError,
  writeExtensionAuditEventForManifest,
  getAuditEventSourceCounters,
  __resetAuditEventSourceCountersForTests,
  __resetAuditEventSourceRateLimitForTests,
} from './audit-event-source.js'

const MANIFEST_NAME = 'com.acme.fixture'
const MANIFEST: ExtensionManifest = {
  name: MANIFEST_NAME,
  apiVersion: EXTENSION_API_VERSION,
  capabilities: ['audit-event-source'],
}
const NO_CAPABILITY_MANIFEST: ExtensionManifest = {
  name: MANIFEST_NAME,
  apiVersion: EXTENSION_API_VERSION,
  capabilities: [],
}
const VALID_EVENT_TYPE = 'ext.com.acme.fixture.thing_happened'
const REPLAY_CREATED_AT = new Date('2026-10-02T00:00:00Z')

beforeEach(() => {
  vi.clearAllMocks()
  __resetAuditEventSourceCountersForTests()
  __resetAuditEventSourceRateLimitForTests()
  writeExtensionAuditEntry.mockResolvedValue({
    id: 'row-1',
    createdAt: new Date('2026-08-17T00:00:00Z'),
  })
})

afterEach(() => {
  __resetAuditEventSourceCountersForTests()
  __resetAuditEventSourceRateLimitForTests()
})

describe('writeExtensionAuditEventForManifest — AC-15/AC-16/AC-17/AC-18/AC-19', () => {
  it('AC-16: throws ExtensionAuditCapabilityNotDeclaredError before opening any transaction when undeclared', async () => {
    await expect(
      writeExtensionAuditEventForManifest(NO_CAPABILITY_MANIFEST, {
        eventType: VALID_EVENT_TYPE,
        orgId: 'org-1',
        payload: {},
      })
    ).rejects.toBeInstanceOf(ExtensionAuditCapabilityNotDeclaredError)
    expect(withOrg).not.toHaveBeenCalled()
  })

  it('AC-15: rejects an eventType missing the ext.<manifest.name>. prefix, before opening a transaction', async () => {
    await expect(
      writeExtensionAuditEventForManifest(MANIFEST, {
        eventType: 'not.namespaced.event',
        orgId: 'org-1',
        payload: {},
      })
    ).rejects.toBeInstanceOf(ExtensionAuditEventTypeNamespaceError)
    expect(withOrg).not.toHaveBeenCalled()
  })

  it('AC-15 edge case: rejects a bare ext.<name>. prefix with no suffix segment', async () => {
    await expect(
      writeExtensionAuditEventForManifest(MANIFEST, {
        eventType: `ext.${MANIFEST.name}.`,
        orgId: 'org-1',
        payload: {},
      })
    ).rejects.toBeInstanceOf(ExtensionAuditEventTypeNamespaceError)
  })

  it('AC-15 edge case: rejects a different extension namespace even if otherwise well-formed', async () => {
    await expect(
      writeExtensionAuditEventForManifest(MANIFEST, {
        eventType: 'ext.com.other.extension.thing_happened',
        orgId: 'org-1',
        payload: {},
      })
    ).rejects.toBeInstanceOf(ExtensionAuditEventTypeNamespaceError)
  })

  it('happy path: opens withOrg(input.orgId), delegates to writeExtensionAuditEntry, returns id/createdAt', async () => {
    const result = await writeExtensionAuditEventForManifest(MANIFEST, {
      eventType: VALID_EVENT_TYPE,
      orgId: 'org-1',
      resourceId: 'resource-1',
      resourceType: 'widget',
      payload: { foo: 'bar' },
    })

    expect(withOrg).toHaveBeenCalledWith('org-1', expect.any(Function))
    expect(writeExtensionAuditEntry).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        orgId: 'org-1',
        eventType: VALID_EVENT_TYPE,
        resourceId: 'resource-1',
        resourceType: 'widget',
        payload: { foo: 'bar' },
        extensionName: 'com.acme.fixture',
      })
    )
    expect(result).toEqual({ id: 'row-1', createdAt: '2026-08-17T00:00:00.000Z' })
    expect(Object.keys(result)).toEqual(['id', 'createdAt'])
  })

  it('AC-18: quota exhaustion propagates as a rejected promise, not a silent no-op', async () => {
    writeExtensionAuditEntry.mockRejectedValue(
      new SameTransactionAuditWriteError('quota exhausted', 'audit_quota_exhausted')
    )

    await expect(
      writeExtensionAuditEventForManifest(MANIFEST, {
        eventType: VALID_EVENT_TYPE,
        orgId: 'org-1',
        payload: {},
      })
    ).rejects.toBeInstanceOf(SameTransactionAuditWriteError)
  })

  it('AC-19: every call opens its own fresh transaction — two calls, two withOrg invocations', async () => {
    await writeExtensionAuditEventForManifest(MANIFEST, {
      eventType: VALID_EVENT_TYPE,
      orgId: 'org-1',
      payload: {},
    })
    await writeExtensionAuditEventForManifest(MANIFEST, {
      eventType: VALID_EVENT_TYPE,
      orgId: 'org-1',
      payload: {},
    })
    expect(withOrg).toHaveBeenCalledTimes(2)
  })
})

describe('writeExtensionAuditEventForManifest — AC-24 counters', () => {
  it('increments writes/succeeded on a happy-path call', async () => {
    await writeExtensionAuditEventForManifest(MANIFEST, {
      eventType: VALID_EVENT_TYPE,
      orgId: 'org-1',
      payload: {},
    })
    expect(getAuditEventSourceCounters()).toEqual({
      writes: 1,
      succeeded: 1,
      rejected: 0,
      deduped: 0,
    })
  })

  it('increments writes/rejected on a capability-not-declared rejection', async () => {
    await writeExtensionAuditEventForManifest(NO_CAPABILITY_MANIFEST, {
      eventType: VALID_EVENT_TYPE,
      orgId: 'org-1',
      payload: {},
    }).catch(() => undefined)
    expect(getAuditEventSourceCounters()).toEqual({
      writes: 1,
      succeeded: 0,
      rejected: 1,
      deduped: 0,
    })
  })
})

describe('writeExtensionAuditEventForManifest — AC-23 operational logging', () => {
  it('logs EXTENSION_AUDIT_EVENT_WRITE_SUCCEEDED on success', async () => {
    const info = vi.fn()
    await writeExtensionAuditEventForManifest(
      MANIFEST,
      { eventType: VALID_EVENT_TYPE, orgId: 'org-1', payload: {} },
      { logger: { info } }
    )
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'extension_audit_event.write_succeeded' }),
      expect.any(String)
    )
  })

  it('rate-limits repeated SUCCEEDED logs for the same eventType within the window', async () => {
    const info = vi.fn()
    for (let i = 0; i < 3; i += 1) {
      await writeExtensionAuditEventForManifest(
        MANIFEST,
        { eventType: VALID_EVENT_TYPE, orgId: 'org-1', payload: {} },
        { logger: { info } }
      )
    }
    expect(info).toHaveBeenCalledTimes(1)
  })

  it('logs EXTENSION_AUDIT_EVENT_WRITE_REJECTED with a fixed-enum reason, never the raw payload', async () => {
    const warn = vi.fn()
    await writeExtensionAuditEventForManifest(
      NO_CAPABILITY_MANIFEST,
      { eventType: VALID_EVENT_TYPE, orgId: 'org-1', payload: { sensitiveField: 'do-not-log' } },
      { logger: { warn } }
    ).catch(() => undefined)
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'extension_audit_event.write_rejected',
        reason: 'capability_not_declared',
      }),
      expect.any(String)
    )
    const loggedPayload = JSON.stringify(warn.mock.calls[0])
    expect(loggedPayload).not.toContain('do-not-log')
  })
})

describe('writeExtensionAuditEventForManifest — Story 71.1 idempotencyKey', () => {
  const KEYED = {
    eventType: VALID_EVENT_TYPE,
    orgId: 'org-1',
    projectId: 'project-1',
    payload: { foo: 'bar' },
    idempotencyKey: 'cm-evt-123:v1',
  }

  beforeEach(() => {
    writeIdempotentExtensionAuditEntry.mockResolvedValue({
      id: 'row-1',
      createdAt: REPLAY_CREATED_AT,
      deduped: false,
    })
  })

  it('AC-1 additive: a keyless call never touches the idempotency helper and behaves as before', async () => {
    const result = await writeExtensionAuditEventForManifest(MANIFEST, {
      eventType: VALID_EVENT_TYPE,
      orgId: 'org-1',
      payload: {},
    })
    expect(writeIdempotentExtensionAuditEntry).not.toHaveBeenCalled()
    expect(writeExtensionAuditEntry).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ id: 'row-1', createdAt: '2026-08-17T00:00:00.000Z' })
  })

  it.each(['', 'x'.repeat(129), 'a b', 'a/b', 'caf\u00e9', 42 as unknown as string])(
    'AC-1: invalid key %j throws the typed error before any transaction, counted rejected',
    async (idempotencyKey) => {
      const warn = vi.fn()
      await expect(
        writeExtensionAuditEventForManifest(
          MANIFEST,
          { ...KEYED, idempotencyKey },
          { logger: { warn } }
        )
      ).rejects.toBeInstanceOf(ExtensionAuditIdempotencyKeyInvalidError)
      expect(withOrg).not.toHaveBeenCalled()
      expect(getAuditEventSourceCounters()).toEqual({
        writes: 1,
        succeeded: 0,
        rejected: 1,
        deduped: 0,
      })
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'idempotency_key_invalid' }),
        expect.any(String)
      )
    }
  )

  it('AC-1: a valid key routes through the helper with manifest name, projectId and key', async () => {
    const result = await writeExtensionAuditEventForManifest(MANIFEST, KEYED)
    expect(writeIdempotentExtensionAuditEntry).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        orgId: 'org-1',
        projectId: 'project-1',
        extensionName: MANIFEST_NAME,
        idempotencyKey: 'cm-evt-123:v1',
      })
    )
    expect(writeExtensionAuditEntry).not.toHaveBeenCalled()
    expect(result).toEqual({ id: 'row-1', createdAt: '2026-10-02T00:00:00.000Z' })
  })

  it('namespace/capability gates still run ahead of any key handling', async () => {
    await expect(
      writeExtensionAuditEventForManifest(NO_CAPABILITY_MANIFEST, KEYED)
    ).rejects.toBeInstanceOf(ExtensionAuditCapabilityNotDeclaredError)
    expect(writeIdempotentExtensionAuditEntry).not.toHaveBeenCalled()
  })

  it('AC-7: a deduped replay increments deduped (not succeeded), counts as a write, and logs without key/payload', async () => {
    writeIdempotentExtensionAuditEntry.mockResolvedValue({
      id: 'row-1',
      createdAt: REPLAY_CREATED_AT,
      deduped: true,
    })
    const info = vi.fn()
    const result = await writeExtensionAuditEventForManifest(MANIFEST, KEYED, {
      logger: { info },
    })
    expect(result).toEqual({ id: 'row-1', createdAt: '2026-10-02T00:00:00.000Z' })
    expect(getAuditEventSourceCounters()).toEqual({
      writes: 1,
      succeeded: 0,
      rejected: 0,
      deduped: 1,
    })
    expect(info).toHaveBeenCalledTimes(1)
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'extension_audit_event.write_deduped' }),
      expect.any(String)
    )
    const logged = JSON.stringify(info.mock.calls[0])
    expect(logged).not.toContain('cm-evt-123')
    expect(logged).not.toContain('"foo"')
  })

  it('AC-7: replay logs are rate-limited like success logs', async () => {
    writeIdempotentExtensionAuditEntry.mockResolvedValue({
      id: 'row-1',
      createdAt: REPLAY_CREATED_AT,
      deduped: true,
    })
    const info = vi.fn()
    for (let i = 0; i < 3; i += 1) {
      await writeExtensionAuditEventForManifest(MANIFEST, KEYED, { logger: { info } })
    }
    expect(info).toHaveBeenCalledTimes(1)
  })

  it('AC-3: a conflict propagates, counts rejected with reason idempotency_conflict, never acknowledges', async () => {
    writeIdempotentExtensionAuditEntry.mockRejectedValue(
      new ExtensionAuditIdempotencyConflictError()
    )
    const warn = vi.fn()
    await expect(
      writeExtensionAuditEventForManifest(MANIFEST, KEYED, { logger: { warn } })
    ).rejects.toBeInstanceOf(ExtensionAuditIdempotencyConflictError)
    expect(getAuditEventSourceCounters()).toEqual({
      writes: 1,
      succeeded: 0,
      rejected: 1,
      deduped: 0,
    })
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'idempotency_conflict' }),
      expect.any(String)
    )
  })

  it('a lost key-insert race is retried once on a fresh transaction and then resolves as a replay', async () => {
    const { ExtensionAuditIdempotencyRaceError } =
      await import('../modules/audit/extension-idempotency.js')
    writeIdempotentExtensionAuditEntry
      .mockRejectedValueOnce(new ExtensionAuditIdempotencyRaceError())
      .mockResolvedValueOnce({
        id: 'row-1',
        createdAt: REPLAY_CREATED_AT,
        deduped: true,
      })
    await writeExtensionAuditEventForManifest(MANIFEST, KEYED)
    expect(withOrg).toHaveBeenCalledTimes(2)
    expect(getAuditEventSourceCounters().deduped).toBe(1)
  })
})
