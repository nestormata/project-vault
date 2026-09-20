import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExtensionManifest } from '@project-vault/extension-api'
import {
  callOutOfRequestHostMethod,
  createInFlightSlotAccounting,
} from './out-of-request-host-wrapper.js'

/**
 * Story 58.2 Task 5 — two `describe` blocks per the story's own ADR (see "Elicitation Findings" /
 * Open Design Question 2 in the story file): direct unit coverage of the shared module in
 * isolation, then a cross-host independence proof that imports both real host-building functions.
 *
 * The cross-host block mocks `@project-vault/db`'s `withOrg` and
 * `../modules/monitoring/service.js`'s `listServiceEndpointsForOrg`, mirroring
 * `monitoring-host.list-service-endpoints-for-scheduling.test.ts`'s own precedent for isolating a
 * host method's control flow from a live database — this file needs BOTH hosts' out-of-request
 * methods runnable without a real Postgres connection.
 */

// Shared assertion-failure message for every `onDenied` hook in this file that must never be
// invoked — a constant avoids sonarjs/no-duplicate-string tripping on this literal repeated
// across the several tests that assert a slot is successfully acquired (not denied).
const UNEXPECTED_DENIAL_MESSAGE = 'should not be denied'

const { withOrg } = vi.hoisted(() => ({ withOrg: vi.fn() }))
vi.mock('@project-vault/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@project-vault/db')>()
  return { ...actual, withOrg }
})

const { listServiceEndpointsForOrg } = vi.hoisted(() => ({
  listServiceEndpointsForOrg: vi.fn(),
}))
vi.mock('../modules/monitoring/service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../modules/monitoring/service.js')>()
  return { ...actual, listServiceEndpointsForOrg }
})

const {
  buildMonitoringHost,
  __getMonitoringHostInFlightCountForTests,
  __resetMonitoringHostRateLimitForTests,
} = await import('./monitoring-host.js')
const {
  buildNotificationOriginatorHost,
  __getNotificationOriginatorHostInFlightCountForTests,
  __resetNotificationOriginatorHostInFlightForTests,
} = await import('./notification-originator-host.js')

describe('createInFlightSlotAccounting / callOutOfRequestHostMethod', () => {
  it('acquires and releases a slot around a successful call', async () => {
    const accounting = createInFlightSlotAccounting('unit-test-ns-success')
    const outcomes: string[] = []

    const result = await callOutOfRequestHostMethod({
      accounting,
      extensionName: 'ext-a',
      maxInFlight: 1,
      onDenied: () => {
        throw new Error(UNEXPECTED_DENIAL_MESSAGE)
      },
      onOutcome: (outcome) => outcomes.push(outcome),
      fn: async () => 'ok-value',
    })

    expect(result).toBe('ok-value')
    expect(outcomes).toEqual(['ok'])
    expect(accounting.getCount('ext-a')).toBe(0)
  })

  it('calls onDenied (which throws) BEFORE fn() is ever invoked when the cap is exhausted', async () => {
    const accounting = createInFlightSlotAccounting('unit-test-ns-deny')
    let fnCalls = 0
    let releaseHeld: (() => void) | undefined
    const holdSlot = () =>
      callOutOfRequestHostMethod({
        accounting,
        extensionName: 'ext-b',
        maxInFlight: 1,
        onDenied: () => {
          throw new Error(UNEXPECTED_DENIAL_MESSAGE)
        },
        onOutcome: () => {},
        fn: () =>
          new Promise<string>((resolve) => {
            releaseHeld = () => resolve('held')
          }),
      })

    const held = holdSlot()

    await expect(
      callOutOfRequestHostMethod({
        accounting,
        extensionName: 'ext-b',
        maxInFlight: 1,
        onDenied: () => {
          throw new Error('denied')
        },
        onOutcome: () => {},
        fn: async () => {
          fnCalls += 1
          return 'unreachable'
        },
      })
    ).rejects.toThrow('denied')

    expect(fnCalls).toBe(0)
    releaseHeld?.()
    await held
    expect(accounting.getCount('ext-b')).toBe(0)
  })

  it('classifyOutcome defaults to () => "error" when not supplied', async () => {
    const accounting = createInFlightSlotAccounting('unit-test-ns-default-classify')
    const outcomes: string[] = []

    await expect(
      callOutOfRequestHostMethod({
        accounting,
        extensionName: 'ext-c',
        maxInFlight: 1,
        onDenied: () => {
          throw new Error(UNEXPECTED_DENIAL_MESSAGE)
        },
        onOutcome: (outcome) => outcomes.push(outcome),
        fn: async () => {
          throw new Error('boom')
        },
      })
    ).rejects.toThrow('boom')

    expect(outcomes).toEqual(['error'])
  })

  it('uses a caller-supplied classifyOutcome override instead of the default', async () => {
    const accounting = createInFlightSlotAccounting('unit-test-ns-override-classify')
    const outcomes: string[] = []

    await expect(
      callOutOfRequestHostMethod({
        accounting,
        extensionName: 'ext-d',
        maxInFlight: 1,
        onDenied: () => {
          throw new Error(UNEXPECTED_DENIAL_MESSAGE)
        },
        onOutcome: (outcome) => outcomes.push(outcome),
        classifyOutcome: () => 'custom-outcome',
        fn: async () => {
          throw new Error('boom')
        },
      })
    ).rejects.toThrow('boom')

    expect(outcomes).toEqual(['custom-outcome'])
  })

  it('propagates an exception thrown by classifyOutcome itself, rather than swallowing it as "error"', async () => {
    const accounting = createInFlightSlotAccounting('unit-test-ns-classify-throws')
    const outcomes: string[] = []

    await expect(
      callOutOfRequestHostMethod({
        accounting,
        extensionName: 'ext-e',
        maxInFlight: 1,
        onDenied: () => {
          throw new Error(UNEXPECTED_DENIAL_MESSAGE)
        },
        onOutcome: (outcome) => outcomes.push(outcome),
        classifyOutcome: () => {
          throw new Error('classifyOutcome bug')
        },
        fn: async () => {
          throw new Error('original error')
        },
      })
    ).rejects.toThrow('classifyOutcome bug')

    // onOutcome must never have been called — classifyOutcome's own exception replaces the
    // original error/outcome recording entirely.
    expect(outcomes).toEqual([])
    // The slot is still released even though classifyOutcome itself threw.
    expect(accounting.getCount('ext-e')).toBe(0)
  })

  it('maxInFlight: 0 denies every call immediately, fn() never invoked', async () => {
    const accounting = createInFlightSlotAccounting('unit-test-ns-zero-cap')
    let fnCalls = 0

    await expect(
      callOutOfRequestHostMethod({
        accounting,
        extensionName: 'ext-f',
        maxInFlight: 0,
        onDenied: () => {
          throw new Error('denied at zero cap')
        },
        onOutcome: () => {},
        fn: async () => {
          fnCalls += 1
          return 'unreachable'
        },
      })
    ).rejects.toThrow('denied at zero cap')

    expect(fnCalls).toBe(0)
    expect(accounting.getCount('ext-f')).toBe(0)
  })

  it('clamps release() at 0 — a double-release never goes negative', () => {
    const accounting = createInFlightSlotAccounting('unit-test-ns-double-release')

    expect(accounting.tryAcquire('ext-g', 1)).toBe(true)
    expect(accounting.getCount('ext-g')).toBe(1)

    accounting.release('ext-g')
    expect(accounting.getCount('ext-g')).toBe(0)

    // Second, unmatched release — must clamp at 0, never go negative.
    accounting.release('ext-g')
    expect(accounting.getCount('ext-g')).toBe(0)
  })

  it('throws synchronously if createInFlightSlotAccounting is called twice with the same namespace', () => {
    createInFlightSlotAccounting('unit-test-ns-collision-guard')

    expect(() => createInFlightSlotAccounting('unit-test-ns-collision-guard')).toThrow(
      /already in use/
    )
  })

  it('reset() clears all accounting state for the instance', () => {
    const accounting = createInFlightSlotAccounting('unit-test-ns-reset')
    accounting.tryAcquire('ext-h', 5)
    expect(accounting.getCount('ext-h')).toBe(1)
    accounting.reset()
    expect(accounting.getCount('ext-h')).toBe(0)
  })
})

describe('cross-host independence', () => {
  const MANIFEST: ExtensionManifest = {
    name: 'com.acme.cross-host-test-extension',
    apiVersion: '3.12.0',
    capabilities: [],
  }

  // Test-fixture UUID, not a secret.
  /* eslint-disable no-secrets/no-secrets */
  const ORG_ID = '55555555-5555-5555-5555-555555555555'
  /* eslint-enable no-secrets/no-secrets */

  const RAW_ROW = { id: 'endpoint-1' }

  /** Satisfies BOTH hosts' `tx` usage: monitoring's `listServiceEndpointsForScheduling` never
   * touches `tx` directly (the service-layer call is mocked above), while notification's
   * `enqueueNotificationForOrg` queries `tx` directly for its rolling-window rate-limit check and
   * insert — mirrors `notification-originator-host.enqueue-for-org.test.ts`'s own `makeFakeTx`
   * precedent. */
  function makeFakeTx() {
    return {
      select: () => ({
        from: () => ({
          where: () => Promise.resolve([{ count: 0 }]),
        }),
      }),
      insert: () => ({
        values: () => ({
          returning: () => Promise.resolve([{ id: 'nq-fake-id' }]),
        }),
      }),
    }
  }
  const FAKE_TX = makeFakeTx()

  beforeEach(() => {
    vi.clearAllMocks()
    withOrg.mockImplementation(async (_orgId: string, fn: (tx: unknown) => unknown) => fn(FAKE_TX))
    listServiceEndpointsForOrg.mockResolvedValue([RAW_ROW])
    __resetMonitoringHostRateLimitForTests()
    __resetNotificationOriginatorHostInFlightForTests()
  })

  afterEach(() => {
    __resetMonitoringHostRateLimitForTests()
    __resetNotificationOriginatorHostInFlightForTests()
    vi.restoreAllMocks()
  })

  it('saturating monitoring-host.ts in-flight cap for an extension does not affect notification-originator-host.ts for the SAME extension name', async () => {
    const monitoringHost = buildMonitoringHost(MANIFEST, {}, { maxInFlight: 1 })
    const notificationHost = buildNotificationOriginatorHost(MANIFEST, {}, { maxInFlight: 1 })

    expect(__getMonitoringHostInFlightCountForTests(MANIFEST.name)).toBe(0)
    expect(__getNotificationOriginatorHostInFlightCountForTests(MANIFEST.name)).toBe(0)

    // Saturate monitoring-host.ts's in-flight cap (maxInFlight: 1) for this extension name by
    // holding one call open via an unresolved service-layer promise.
    let releaseHeld: (() => void) | undefined
    listServiceEndpointsForOrg.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseHeld = () => resolve([RAW_ROW])
        })
    )

    const held = monitoringHost.listServiceEndpointsForScheduling({ organizationId: ORG_ID })

    // monitoring-host.ts is now at its cap for this extension name.
    await expect(
      monitoringHost.listServiceEndpointsForScheduling({ organizationId: ORG_ID })
    ).rejects.toThrow(/in-flight cap|rate/i)
    expect(__getMonitoringHostInFlightCountForTests(MANIFEST.name)).toBe(1)

    // notification-originator-host.ts's own accounting instance is entirely unaffected — a call
    // for the SAME extensionName must succeed despite monitoring's exhausted cap.
    const result = await notificationHost.enqueueNotificationForOrg({
      organizationId: ORG_ID,
      channel: 'email',
      recipientEmail: 'user@example.com',
      subject: 'cross-host independence check',
      body: 'body',
    })
    expect(result).toEqual({ notificationQueueId: 'nq-fake-id' })
    expect(__getNotificationOriginatorHostInFlightCountForTests(MANIFEST.name)).toBe(0)

    releaseHeld?.()
    await expect(held).resolves.toEqual([RAW_ROW])
    expect(__getMonitoringHostInFlightCountForTests(MANIFEST.name)).toBe(0)
  })
})
