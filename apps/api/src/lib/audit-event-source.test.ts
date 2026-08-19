import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EXTENSION_API_VERSION } from '@project-vault/extension-api'
import type { ExtensionManifest } from '@project-vault/extension-api'
import { SameTransactionAuditWriteError } from './secure-route.js'

const { writeExtensionAuditEntry } = vi.hoisted(() => ({
  writeExtensionAuditEntry: vi.fn(),
}))
vi.mock('../modules/audit/extension-entry.js', () => ({ writeExtensionAuditEntry }))

const { withOrg } = vi.hoisted(() => ({
  withOrg: vi.fn(async (_orgId: string, fn: (tx: unknown) => unknown) => fn({})),
}))
vi.mock('@project-vault/db', () => ({ withOrg }))

import {
  ExtensionAuditCapabilityNotDeclaredError,
  ExtensionAuditEventTypeNamespaceError,
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
    expect(getAuditEventSourceCounters()).toEqual({ writes: 1, succeeded: 1, rejected: 0 })
  })

  it('increments writes/rejected on a capability-not-declared rejection', async () => {
    await writeExtensionAuditEventForManifest(NO_CAPABILITY_MANIFEST, {
      eventType: VALID_EVENT_TYPE,
      orgId: 'org-1',
      payload: {},
    }).catch(() => undefined)
    expect(getAuditEventSourceCounters()).toEqual({ writes: 1, succeeded: 0, rejected: 1 })
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
