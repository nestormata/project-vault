import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CapabilityDecision, CapabilityGate } from '@project-vault/extension-api'
import { CapabilityId } from '@project-vault/shared'
import {
  CAPABILITY_GATE_MAX_IN_FLIGHT_PER_SURFACE,
  __getCapabilityGateInFlightCountForTests,
  __resetCapabilityGateCountersForTests,
  __resetCapabilityGateForTests,
  __resetCapabilityGateInFlightForTests,
  __resetCapabilityGateRateLimitForTests,
  assertCapability,
  checkCapability,
  getCapabilityGate,
  getCapabilityGateCounters,
  wireExtensionCapabilityGate,
} from './capability-gate.js'
import type { ExtensionState } from '../extensions/loader.js'

function loadedState(capabilityGate: CapabilityGate | undefined): ExtensionState {
  return {
    status: 'loaded',
    manifest: { name: 'com.example.ext', apiVersion: '1.2.0', capabilities: [] },
    loadedAt: new Date().toISOString(),
    hooks: capabilityGate ? { capabilityGate } : {},
  }
}

function makeGate(onCheckCapability: CapabilityGate['onCheckCapability']): CapabilityGate {
  return { onCheckCapability }
}

const baseInput = {
  capability: CapabilityId.MONITORING_PUBLIC_STATUS_PAGE,
  orgId: 'org_1',
  userId: 'user_1',
  orgRole: 'admin' as const,
  surface: 'org' as const,
}

describe('capability-gate.ts — boot wiring (AC7, AC8)', () => {
  beforeEach(() => __resetCapabilityGateForTests())
  afterEach(() => __resetCapabilityGateForTests())

  it('no-ops for not_configured', () => {
    wireExtensionCapabilityGate({ status: 'not_configured' })
    expect(getCapabilityGate()).toBeNull()
  })

  it('no-ops for load_failed', () => {
    wireExtensionCapabilityGate({ status: 'load_failed', reason: 'import_error' })
    expect(getCapabilityGate()).toBeNull()
  })

  it('no-ops for loaded without a capabilityGate hook', () => {
    wireExtensionCapabilityGate(loadedState(undefined))
    expect(getCapabilityGate()).toBeNull()
  })

  it('registers the exact hook object reference (identity, not deep equality)', () => {
    const gate = makeGate(async () => ({ permitted: true }))
    wireExtensionCapabilityGate(loadedState(gate))
    expect(getCapabilityGate()).toBe(gate)
  })

  it('a second wiring call no-ops and logs CAPABILITY_GATE_DOUBLE_WIRE_IGNORED at warn, never replacing the gate', () => {
    const first = makeGate(async () => ({ permitted: true }))
    const second = makeGate(async () => ({ permitted: false, reasonCode: 'x' }))
    wireExtensionCapabilityGate(loadedState(first))
    const warn = vi.fn()
    wireExtensionCapabilityGate(loadedState(second), { warn })
    expect(getCapabilityGate()).toBe(first)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toEqual({
      eventType: 'capability_gate.double_wire_ignored',
      traceId: 'system',
    })
  })
})

describe('checkCapability — fail-closed for a registered gate (AC11, AC12)', () => {
  it('happy path: permitted:true resolves permitted', async () => {
    const gate = makeGate(async () => ({ permitted: true }))
    const result = await checkCapability(gate, baseInput)
    expect(result).toEqual({ permitted: true })
  })

  it('happy path: explicit permitted:false passes through reasonCode/message verbatim', async () => {
    const gate = makeGate(async () => ({
      permitted: false,
      reasonCode: 'zzz_unknown_to_pv',
      message: 'Upgrade to enable this.',
    }))
    const result = await checkCapability(gate, baseInput)
    expect(result).toEqual({
      permitted: false,
      reasonCode: 'zzz_unknown_to_pv',
      message: 'Upgrade to enable this.',
    })
  })

  it('synchronous throw -> fail closed with gate_unavailable, process does not crash', async () => {
    const gate = makeGate((() => {
      throw new Error('boom')
    }) as unknown as CapabilityGate['onCheckCapability'])
    const result = await checkCapability(gate, baseInput)
    expect(result).toMatchObject({ permitted: false, reasonCode: 'gate_unavailable' })
  })

  it('rejected promise -> fail closed with gate_unavailable', async () => {
    const gate = makeGate(async () => {
      throw new Error('boom')
    })
    const result = await checkCapability(gate, baseInput)
    expect(result).toMatchObject({ permitted: false, reasonCode: 'gate_unavailable' })
  })

  it('hang -> resolves within the timeout bound with gate_unavailable', async () => {
    const gate = makeGate(() => new Promise<CapabilityDecision>(() => undefined))
    const start = Date.now()
    const result = await checkCapability(gate, { ...baseInput, timeoutMs: 20 })
    expect(Date.now() - start).toBeLessThan(500)
    expect(result).toMatchObject({ permitted: false, reasonCode: 'gate_unavailable' })
  })

  it('a subsequent request with a now-working gate succeeds after a prior throw (no sticky poisoning)', async () => {
    let callCount = 0
    const gate = makeGate(async () => {
      callCount += 1
      if (callCount === 1) throw new Error('boom')
      return { permitted: true }
    })
    const first = await checkCapability(gate, baseInput)
    const second = await checkCapability(gate, baseInput)
    expect(first).toMatchObject({ permitted: false, reasonCode: 'gate_unavailable' })
    expect(second).toEqual({ permitted: true })
  })

  describe('malformed decisions (AC12)', () => {
    const malformedCases: Array<[string, unknown]> = [
      ['undefined', undefined],
      ['null', null],
      ['true', true],
      ["'yes'", 'yes'],
      ['{}', {}],
      ['permitted as string', { permitted: 'true' }],
      ['permitted:false missing reasonCode', { permitted: false }],
      ['reasonCode as number', { permitted: false, reasonCode: 42 }],
      [
        'reasonCode over 200 chars (rejected, not truncated)',
        { permitted: false, reasonCode: 'x'.repeat(10_000) },
      ],
    ]
    it.each(malformedCases)('%s -> gate_malformed_decision', async (_label, value) => {
      const gate = makeGate(async () => value as CapabilityDecision)
      const result = await checkCapability(gate, baseInput)
      expect(result).toMatchObject({ permitted: false, reasonCode: 'gate_malformed_decision' })
    })
  })

  it('permitted:true with an extra unknown field is allowed, extra key stripped, no special log', async () => {
    const gate = makeGate(
      async () => ({ permitted: true, someFutureField: 1 }) as unknown as CapabilityDecision
    )
    const result = await checkCapability(gate, baseInput)
    expect(result).toEqual({ permitted: true })
  })

  it('permitted:true with reasonCode present is honored but logged as suspicious (warn)', async () => {
    const gate = makeGate(
      async () => ({ permitted: true, reasonCode: 'x' }) as unknown as CapabilityDecision
    )
    const warn = vi.fn()
    const result = await checkCapability(gate, { ...baseInput, logger: { warn } })
    expect(result).toEqual({ permitted: true })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toMatchObject({
      eventType: 'capability_gate.suspicious_decision',
      subReason: 'permitted_with_reason_code',
    })
  })

  it('message longer than 300 chars is truncated with a trailing ellipsis marker', async () => {
    const gate = makeGate(async () => ({
      permitted: false,
      reasonCode: 'too_long_message',
      message: 'x'.repeat(400),
    }))
    const result = (await checkCapability(gate, baseInput)) as { message?: string }
    expect(result.message).toHaveLength(301)
    expect(result.message?.endsWith('…')).toBe(true)
  })

  it('message absent falls back to a fixed PV-localized message', async () => {
    const gate = makeGate(async () => ({ permitted: false, reasonCode: 'no_message' }))
    const result = (await checkCapability(gate, baseInput)) as { message?: string }
    expect(result.message).toBe('This capability is not available for your organization.')
  })

  it('two requests sending the same X-Request-ID header produce two different gateCallIds', async () => {
    const seen: string[] = []
    const gate = makeGate(async (ctx) => {
      seen.push(ctx.gateCallId)
      return { permitted: true }
    })
    await checkCapability(gate, { ...baseInput, requestId: 'attacker-pinned-uuid' })
    await checkCapability(gate, { ...baseInput, requestId: 'attacker-pinned-uuid' })
    expect(seen[0]).not.toBe(seen[1])
  })
})

describe('assertCapability — the imperative call site (AC10, AC24)', () => {
  beforeEach(() => __resetCapabilityGateForTests())
  afterEach(() => __resetCapabilityGateForTests())

  it('fails OPEN (permitted:true) when no gate is registered', async () => {
    const result = await assertCapability({
      capability: CapabilityId.MONITORING_PUBLIC_STATUS_PAGE,
      orgId: null,
      userId: null,
      orgRole: null,
      surface: 'public',
    })
    expect(result).toEqual({ permitted: true })
  })

  it('delegates to the registered gate when one exists', async () => {
    const gate = makeGate(async () => ({ permitted: false, reasonCode: 'denied_by_ext' }))
    wireExtensionCapabilityGate(loadedState(gate))
    const result = await assertCapability({
      capability: CapabilityId.MONITORING_PUBLIC_STATUS_PAGE,
      orgId: 'org_1',
      userId: null,
      orgRole: null,
      surface: 'public',
    })
    expect(result).toMatchObject({ permitted: false, reasonCode: 'denied_by_ext' })
  })
})

describe('checkCapability — per-surface in-flight cap (AC-15)', () => {
  beforeEach(() => {
    __resetCapabilityGateInFlightForTests()
    __resetCapabilityGateCountersForTests()
    __resetCapabilityGateRateLimitForTests()
  })
  afterEach(() => {
    __resetCapabilityGateInFlightForTests()
    __resetCapabilityGateCountersForTests()
    __resetCapabilityGateRateLimitForTests()
  })

  it('at most CAPABILITY_GATE_MAX_IN_FLIGHT_PER_SURFACE calls are ever in flight for the public key', async () => {
    let maxObservedInFlight = 0
    let currentInFlight = 0
    let release: (() => void) | undefined
    const gate = makeGate(async () => {
      currentInFlight += 1
      maxObservedInFlight = Math.max(maxObservedInFlight, currentInFlight)
      await new Promise<void>((resolve) => {
        release = resolve
      })
      currentInFlight -= 1
      return { permitted: true }
    })

    // Fire 100 concurrent public checks against a gate that hangs until manually released one at
    // a time, forcing the cap to actually bind rather than all draining before the next fires.
    const results: Promise<CapabilityDecision>[] = []
    for (let i = 0; i < 20; i += 1) {
      results.push(checkCapability(gate, { ...baseInput, surface: 'public', orgId: null }))
      // Give the microtask queue a chance to let the gate's async body run and register itself.
      await Promise.resolve()
      await Promise.resolve()
    }
    expect(maxObservedInFlight).toBeLessThanOrEqual(CAPABILITY_GATE_MAX_IN_FLIGHT_PER_SURFACE)
    expect(__getCapabilityGateInFlightCountForTests('__public__')).toBeLessThanOrEqual(
      CAPABILITY_GATE_MAX_IN_FLIGHT_PER_SURFACE
    )

    // Drain: release repeatedly until every pending call has resolved.
    while (release) {
      const pendingRelease = release
      release = undefined
      pendingRelease()
      await Promise.resolve()
    }
    await Promise.all(results)
  })

  it('a check arriving over its key cap is denied WITHOUT invoking the gate, subReason gate_saturated', async () => {
    const onCheckCapability = vi.fn(() => new Promise<CapabilityDecision>(() => undefined))
    const gate = makeGate(onCheckCapability)

    const inFlight: Promise<CapabilityDecision>[] = []
    for (let i = 0; i < CAPABILITY_GATE_MAX_IN_FLIGHT_PER_SURFACE; i += 1) {
      inFlight.push(checkCapability(gate, { ...baseInput, surface: 'public', orgId: null }))
    }
    await Promise.resolve()
    await Promise.resolve()
    expect(onCheckCapability).toHaveBeenCalledTimes(CAPABILITY_GATE_MAX_IN_FLIGHT_PER_SURFACE)

    const overCap = await checkCapability(gate, { ...baseInput, surface: 'public', orgId: null })
    expect(overCap).toMatchObject({ permitted: false, reasonCode: 'gate_unavailable' })
    expect(onCheckCapability).toHaveBeenCalledTimes(CAPABILITY_GATE_MAX_IN_FLIGHT_PER_SURFACE)
    expect(getCapabilityGateCounters().saturated).toBe(1)
  })

  it('N4 regression (mandatory): flooding the public surface — even with a valid token belonging to org A — never denies a concurrent org-scoped check for org A or org B with gate_saturated', async () => {
    const gate = makeGate(() => new Promise<CapabilityDecision>(() => undefined))

    // Saturate the public budget, including "valid token for org A" traffic (still keyed
    // '__public__', never orgId, per AC-15).
    const floodPromises: Promise<CapabilityDecision>[] = []
    for (let i = 0; i < CAPABILITY_GATE_MAX_IN_FLIGHT_PER_SURFACE * 3; i += 1) {
      floodPromises.push(
        checkCapability(gate, {
          ...baseInput,
          surface: 'public',
          orgId: i % 2 === 0 ? 'org_A' : null,
        })
      )
    }
    await Promise.resolve()
    await Promise.resolve()

    // Concurrent org-scoped checks for org A and org B must be evaluated normally — a
    // fast-resolving gate answers them immediately, unaffected by the saturated public key.
    const orgGate = makeGate(async () => ({ permitted: true }))
    const orgAResult = await checkCapability(orgGate, {
      ...baseInput,
      surface: 'org',
      orgId: 'org_A',
    })
    const orgBResult = await checkCapability(orgGate, {
      ...baseInput,
      surface: 'org',
      orgId: 'org_B',
    })
    expect(orgAResult).toEqual({ permitted: true })
    expect(orgBResult).toEqual({ permitted: true })
  })

  it('org A saturating its own budget does not affect org B', async () => {
    const hangingGate = makeGate(() => new Promise<CapabilityDecision>(() => undefined))
    const orgAFlood: Promise<CapabilityDecision>[] = []
    for (let i = 0; i < CAPABILITY_GATE_MAX_IN_FLIGHT_PER_SURFACE; i += 1) {
      orgAFlood.push(checkCapability(hangingGate, { ...baseInput, surface: 'org', orgId: 'org_A' }))
    }
    await Promise.resolve()
    await Promise.resolve()

    const overCapForA = await checkCapability(hangingGate, {
      ...baseInput,
      surface: 'org',
      orgId: 'org_A',
    })
    expect(overCapForA).toMatchObject({ reasonCode: 'gate_unavailable' })

    const fastGate = makeGate(async () => ({ permitted: true }))
    const forB = await checkCapability(fastGate, { ...baseInput, surface: 'org', orgId: 'org_B' })
    expect(forB).toEqual({ permitted: true })
  })

  it('100 consecutive explicit denials change no in-flight accounting at all', async () => {
    const gate = makeGate(async () => ({ permitted: false, reasonCode: 'not_entitled' }))
    for (let i = 0; i < 100; i += 1) {
      await checkCapability(gate, { ...baseInput, surface: 'public', orgId: null })
    }
    expect(__getCapabilityGateInFlightCountForTests('__public__')).toBe(0)
  })
})

describe('checkCapability — AC-22 runtime unknown-id backstop', () => {
  it('an id outside the closed CapabilityId set denies with unknown_capability, no gate invocation', async () => {
    const onCheckCapability = vi.fn(async () => ({ permitted: true }) as CapabilityDecision)
    const gate = makeGate(onCheckCapability)
    const result = await checkCapability(gate, {
      ...baseInput,
      capability: 'not.a.real.id' as never,
    })
    expect(result).toMatchObject({ permitted: false, reasonCode: 'unknown_capability' })
    expect(onCheckCapability).not.toHaveBeenCalled()
  })
})

describe('checkCapability — AC-26 counters and AC-10 double-check backstop', () => {
  beforeEach(() => __resetCapabilityGateCountersForTests())
  afterEach(() => __resetCapabilityGateCountersForTests())

  it('counters track checks/permitted/denied', async () => {
    const gate = makeGate(async () => ({ permitted: true }))
    await checkCapability(gate, baseInput)
    const denyGate = makeGate(async () => ({ permitted: false, reasonCode: 'x' }))
    await checkCapability(denyGate, baseInput)
    const counters = getCapabilityGateCounters()
    expect(counters.checks).toBe(2)
    expect(counters.permitted).toBe(1)
    expect(counters.denied).toBe(1)
  })

  it('a throw increments the failed counter', async () => {
    const gate = makeGate(async () => {
      throw new Error('boom')
    })
    await checkCapability(gate, baseInput)
    expect(getCapabilityGateCounters().failed).toBe(1)
  })

  it('checking the same capability twice in one request logs CAPABILITY_GATE_DOUBLE_CHECK but does not memoize', async () => {
    const onCheckCapability = vi.fn(async () => ({ permitted: true }) as CapabilityDecision)
    const gate = makeGate(onCheckCapability)
    const error = vi.fn()
    const perRequestSeen = new Set<string>()
    await checkCapability(gate, { ...baseInput, perRequestSeen, logger: { error } })
    await checkCapability(gate, { ...baseInput, perRequestSeen, logger: { error } })
    expect(onCheckCapability).toHaveBeenCalledTimes(2) // no memoization
    expect(error).toHaveBeenCalledTimes(1)
    expect(error.mock.calls[0]?.[0]).toMatchObject({
      eventType: 'capability_gate.double_check',
    })
  })
})

describe('checkCapability — AC-26 rate-limited logging for high-volume failure events', () => {
  beforeEach(() => __resetCapabilityGateRateLimitForTests())
  afterEach(() => __resetCapabilityGateRateLimitForTests())

  it('CAPABILITY_GATE_FAILED is rate-limited to 1/sec per capability id, with a suppressedCount on the next line', async () => {
    const error = vi.fn()
    const gate = makeGate(async () => {
      throw new Error('boom')
    })
    await checkCapability(gate, { ...baseInput, logger: { error } })
    await checkCapability(gate, { ...baseInput, logger: { error } })
    await checkCapability(gate, { ...baseInput, logger: { error } })
    const failedCalls = error.mock.calls.filter(
      (call) => (call[0] as { eventType?: string }).eventType === 'capability_gate.failed'
    )
    expect(failedCalls).toHaveLength(1)
    expect((failedCalls[0]?.[0] as { suppressedCount?: number }).suppressedCount).toBe(0)
  })

  it('CAPABILITY_GATE_MALFORMED_DECISION is never rate-limited', async () => {
    const error = vi.fn()
    const gate = makeGate(async () => undefined as unknown as CapabilityDecision)
    await checkCapability(gate, { ...baseInput, logger: { error } })
    await checkCapability(gate, { ...baseInput, logger: { error } })
    const malformedCalls = error.mock.calls.filter(
      (call) =>
        (call[0] as { eventType?: string }).eventType === 'capability_gate.malformed_decision'
    )
    expect(malformedCalls).toHaveLength(2)
  })
})
