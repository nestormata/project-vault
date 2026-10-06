import type { AuditEventAttribution } from '$lib/api/audit.js'

/** Story 71.10 D5: occurrence time is shown only when it differs from the recorded time by more
 * than one second (otherwise it is noise). Display-only; ordering and filtering use createdAt. */
const OCCURRED_AT_NOISE_MS = 1000

export type OccurredAtDisplay = { time: string; signed: boolean }

export function occurredAtDisplay(
  createdAt: string,
  attribution: AuditEventAttribution | undefined
): OccurredAtDisplay | null {
  const occurredAt = attribution?.occurredAt
  if (!occurredAt) return null
  const occurredMs = Date.parse(occurredAt)
  const createdMs = Date.parse(createdAt)
  if (Number.isNaN(occurredMs) || Number.isNaN(createdMs)) return null
  if (Math.abs(createdMs - occurredMs) <= OCCURRED_AT_NOISE_MS) return null
  return {
    time: new Date(occurredMs).toLocaleString(),
    signed: attribution?.occurredAtSource === 'delegation_signed',
  }
}
