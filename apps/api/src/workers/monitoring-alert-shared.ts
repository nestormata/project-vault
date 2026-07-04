/**
 * Story 6.2 AC 4-6, ADR-6.2-03/05: pure, DB-free status-transition decision logic for the
 * health-check worker (monitoring-health-check.ts) — analogous to expiry-alert-shared.ts's
 * computeExpiryAlertFirings for 6.1. Fully unit-testable without a database.
 */

export type ServiceEndpointStatus = 'healthy' | 'degraded' | 'down'
export type MonitoringAlertType = 'service.down' | 'service.recovery'

/**
 * ADR-6.2-03 (corrected per adversarial-review finding 4): a half-open range, not a single
 * fixed value — degraded covers every consecutiveFailures value strictly between 0 and
 * downThresholdFailures (exclusive of 0, inclusive up to but not including the threshold).
 * Collapses to the original single-value case exactly when downThresholdFailures = 2 (the
 * default).
 */
export function statusForConsecutiveFailures(
  consecutiveFailures: number,
  downThresholdFailures: number
): ServiceEndpointStatus {
  if (consecutiveFailures <= 0) return 'healthy'
  if (consecutiveFailures >= downThresholdFailures) return 'down'
  return 'degraded'
}

export type StatusTransitionInput = {
  currentStatus: ServiceEndpointStatus
  consecutiveFailures: number
  downThresholdFailures: number
  isHealthy: boolean
}

export type StatusTransitionResult = {
  nextStatus: ServiceEndpointStatus
  nextConsecutiveFailures: number
  /**
   * Only set on the actual TRANSITION into down (from a non-down status) or out of down back
   * to healthy (recovery) — never on a "still down"/"still degraded" repeat check (AC 5's
   * same-episode dedup requirement starts here, at the pure-logic level).
   */
  alertFired: MonitoringAlertType | null
}

export function computeStatusTransition(input: StatusTransitionInput): StatusTransitionResult {
  const nextConsecutiveFailures = input.isHealthy ? 0 : input.consecutiveFailures + 1
  const nextStatus = statusForConsecutiveFailures(
    nextConsecutiveFailures,
    input.downThresholdFailures
  )

  let alertFired: MonitoringAlertType | null = null
  if (input.currentStatus !== 'down' && nextStatus === 'down') {
    alertFired = 'service.down'
  } else if (input.currentStatus === 'down' && nextStatus === 'healthy') {
    alertFired = 'service.recovery'
  }

  return { nextStatus, nextConsecutiveFailures, alertFired }
}

/**
 * ADR-6.2-05: one continuous down-to-recovery span shares a single episodeKey, keyed by the
 * timestamp of the down TRANSITION (not every check) — a later, distinct down episode for the
 * same endpoint gets its own key (a different downTransitionAt), so a new episode is
 * unconditionally a new alert regardless of any earlier snooze.
 */
export function episodeKeyFor(serviceEndpointId: string, downTransitionAt: Date): string {
  return `${serviceEndpointId}:${downTransitionAt.toISOString()}`
}
