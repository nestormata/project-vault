import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { Gauge, register } from 'prom-client'
import { getOrCreateGauge } from './prom-client-registry.js'

const PRE_REGISTERED_HELP = 'pre-registered'

describe('getOrCreateGauge (Story 56.2 Task 3)', () => {
  it('registers a gauge once and returns the same instance on a repeated call', () => {
    const name = `test_gauge_${randomUUID().replaceAll('-', '_')}`
    const config = { name, help: 'test gauge', labelNames: ['a'] as const }
    const first = getOrCreateGauge(config)
    const second = getOrCreateGauge(config)

    expect(first).toBeInstanceOf(Gauge)
    expect(second).toBe(first)
    expect(register.getSingleMetric(name)).toBe(first)
    register.removeSingleMetric(name)
  })

  it('does not throw "already registered" when a gauge of that name already exists', () => {
    const name = `test_gauge_${randomUUID().replaceAll('-', '_')}`
    const existing = new Gauge({ name, help: PRE_REGISTERED_HELP })
    expect(() => getOrCreateGauge({ name, help: PRE_REGISTERED_HELP })).not.toThrow()
    expect(getOrCreateGauge({ name, help: PRE_REGISTERED_HELP })).toBe(existing)
    register.removeSingleMetric(name)
  })
})
