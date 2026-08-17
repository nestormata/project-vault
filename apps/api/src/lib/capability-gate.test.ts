import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CapabilityDecision, CapabilityGate } from '@project-vault/extension-api'
import { CapabilityId } from '@project-vault/shared'
import {
  __resetCapabilityGateForTests,
  assertCapability,
  checkCapability,
  getCapabilityGate,
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
