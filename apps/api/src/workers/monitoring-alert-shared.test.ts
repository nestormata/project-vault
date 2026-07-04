import { describe, expect, it } from 'vitest'
import {
  computeStatusTransition,
  episodeKeyFor,
  statusForConsecutiveFailures,
} from './monitoring-alert-shared.js'

describe('statusForConsecutiveFailures (ADR-6.2-03)', () => {
  it('is healthy when consecutiveFailures is 0', () => {
    expect(statusForConsecutiveFailures(0, 2)).toBe('healthy')
  })

  it('is down once consecutiveFailures reaches downThresholdFailures (default 2)', () => {
    expect(statusForConsecutiveFailures(1, 2)).toBe('degraded')
    expect(statusForConsecutiveFailures(2, 2)).toBe('down')
    expect(statusForConsecutiveFailures(3, 2)).toBe('down')
  })

  it('is degraded for every value strictly between 1 and downThresholdFailures when threshold > 2 (adversarial-review finding 4)', () => {
    // downThresholdFailures = 5: consecutiveFailures 1,2,3,4 are all "degraded"; 5+ is "down".
    expect(statusForConsecutiveFailures(1, 5)).toBe('degraded')
    expect(statusForConsecutiveFailures(2, 5)).toBe('degraded')
    expect(statusForConsecutiveFailures(3, 5)).toBe('degraded')
    expect(statusForConsecutiveFailures(4, 5)).toBe('degraded')
    expect(statusForConsecutiveFailures(5, 5)).toBe('down')
    expect(statusForConsecutiveFailures(6, 5)).toBe('down')
  })

  it('collapses to a single degraded value when downThresholdFailures = 1 (immediate down-alerting)', () => {
    expect(statusForConsecutiveFailures(0, 1)).toBe('healthy')
    expect(statusForConsecutiveFailures(1, 1)).toBe('down')
  })
})

describe('computeStatusTransition (AC 4-6)', () => {
  it('healthy check keeps status healthy and resets consecutiveFailures to 0', () => {
    const result = computeStatusTransition({
      currentStatus: 'healthy',
      consecutiveFailures: 0,
      downThresholdFailures: 2,
      isHealthy: true,
    })
    expect(result).toEqual({
      nextStatus: 'healthy',
      nextConsecutiveFailures: 0,
      alertFired: null,
    })
  })

  it('first failure transitions healthy -> degraded with no alert (default threshold 2)', () => {
    const result = computeStatusTransition({
      currentStatus: 'healthy',
      consecutiveFailures: 0,
      downThresholdFailures: 2,
      isHealthy: false,
    })
    expect(result).toEqual({
      nextStatus: 'degraded',
      nextConsecutiveFailures: 1,
      alertFired: null,
    })
  })

  it('second consecutive failure crosses the down threshold and fires service.down exactly once', () => {
    const result = computeStatusTransition({
      currentStatus: 'degraded',
      consecutiveFailures: 1,
      downThresholdFailures: 2,
      isHealthy: false,
    })
    expect(result).toEqual({
      nextStatus: 'down',
      nextConsecutiveFailures: 2,
      alertFired: 'service.down',
    })
  })

  it('subsequent still-failing checks stay down with no new alert (same episode, AC 5)', () => {
    const result = computeStatusTransition({
      currentStatus: 'down',
      consecutiveFailures: 2,
      downThresholdFailures: 2,
      isHealthy: false,
    })
    expect(result).toEqual({
      nextStatus: 'down',
      nextConsecutiveFailures: 3,
      alertFired: null,
    })
  })

  it('a healthy check after down transitions to healthy and fires service.recovery exactly once (AC 6)', () => {
    const result = computeStatusTransition({
      currentStatus: 'down',
      consecutiveFailures: 5,
      downThresholdFailures: 2,
      isHealthy: true,
    })
    expect(result).toEqual({
      nextStatus: 'healthy',
      nextConsecutiveFailures: 0,
      alertFired: 'service.recovery',
    })
  })

  it('threshold exactly 1: the very first failure both crosses down and fires (no observable degraded state)', () => {
    const result = computeStatusTransition({
      currentStatus: 'healthy',
      consecutiveFailures: 0,
      downThresholdFailures: 1,
      isHealthy: false,
    })
    expect(result).toEqual({
      nextStatus: 'down',
      nextConsecutiveFailures: 1,
      alertFired: 'service.down',
    })
  })

  it('does not fire an alert moving between degraded values below the threshold (finding 4 coverage)', () => {
    const result = computeStatusTransition({
      currentStatus: 'degraded',
      consecutiveFailures: 3,
      downThresholdFailures: 5,
      isHealthy: false,
    })
    expect(result).toEqual({
      nextStatus: 'degraded',
      nextConsecutiveFailures: 4,
      alertFired: null,
    })
  })
})

describe('episodeKeyFor (ADR-6.2-05)', () => {
  it('combines serviceEndpointId and the down-transition timestamp', () => {
    const at = new Date('2026-07-01T00:00:00.000Z')
    expect(episodeKeyFor('se-1', at)).toBe('se-1:2026-07-01T00:00:00.000Z')
  })

  it('produces a different key for a different down-transition timestamp (new episode)', () => {
    const first = episodeKeyFor('se-1', new Date('2026-07-01T00:00:00.000Z'))
    const second = episodeKeyFor('se-1', new Date('2026-07-02T00:00:00.000Z'))
    expect(first).not.toBe(second)
  })
})
