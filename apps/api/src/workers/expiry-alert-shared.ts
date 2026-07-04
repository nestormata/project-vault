import type { NotificationSeverity } from '@project-vault/shared'

const MS_PER_DAY = 86_400_000
const MATCH_TOLERANCE_DAYS = 1

/**
 * Whole days remaining until `expiryDate`, rounded up (a few hours past midnight still counts
 * as "that day"). Negative once the asset is overdue.
 */
export function computeDaysRemaining(expiryDate: Date, now: Date): number {
  return Math.ceil((expiryDate.getTime() - now.getTime()) / MS_PER_DAY)
}

/** AC 5: daysRemaining <= 3 -> critical, <= 7 -> warning, else info. */
export function severityForDaysRemaining(daysRemaining: number): NotificationSeverity {
  if (daysRemaining <= 3) return 'critical'
  if (daysRemaining <= 7) return 'warning'
  return 'info'
}

export type ExpiryAlertFiring = {
  threshold: number
  severity: NotificationSeverity
  overdue: boolean
}

export type ExpiryAlertResult = {
  firings: ExpiryAlertFiring[]
  nextNotifiedLeadDays: number[]
}

/**
 * Pure decision function for AC 5/11 — no DB access, fully unit-testable. Given the asset's
 * current daysRemaining and its alertLeadDays/notifiedLeadDays jsonb arrays, decides which
 * thresholds should fire this run and the notifiedLeadDays value the caller must persist
 * (in the same transaction as any notification-queue insert) to prevent re-firing.
 *
 * Overdue handling (pre-mortem finding): alertLeadDays are always positive, so the +/-1 day
 * match window never catches an asset whose expiry has already passed by more than a day.
 * We additionally fire once, as `threshold: 0, overdue: true`, whenever daysRemaining <= 0 and
 * 0 has not already been notified — this can coexist with a normal positive-threshold firing
 * on the same day (e.g. daysRemaining === 0 with alertLeadDays including 1).
 */
export function computeExpiryAlertFirings(params: {
  daysRemaining: number
  alertLeadDays: number[]
  notifiedLeadDays: number[]
}): ExpiryAlertResult {
  const { daysRemaining, alertLeadDays, notifiedLeadDays } = params
  const firings: ExpiryAlertFiring[] = []
  const nextNotifiedLeadDays = [...notifiedLeadDays]

  for (const threshold of alertLeadDays) {
    if (nextNotifiedLeadDays.includes(threshold)) continue
    if (Math.abs(daysRemaining - threshold) > MATCH_TOLERANCE_DAYS) continue
    firings.push({ threshold, severity: severityForDaysRemaining(daysRemaining), overdue: false })
    nextNotifiedLeadDays.push(threshold)
  }

  if (daysRemaining <= 0 && !nextNotifiedLeadDays.includes(0)) {
    firings.push({ threshold: 0, severity: 'critical', overdue: true })
    nextNotifiedLeadDays.push(0)
  }

  return { firings, nextNotifiedLeadDays }
}
