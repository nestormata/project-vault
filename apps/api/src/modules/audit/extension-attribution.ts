import type { DelegationSnapshot } from '../../lib/request-context.js'
import {
  OCCURRED_AT_MAX_AGE_SECONDS,
  OCCURRED_AT_UNATTESTED_MAX_PAST_SECONDS,
  classifyOccurrence,
} from '../../lib/occurrence-window.js'

/**
 * Story 71.4 — attribution of an extension-written audit event: WHO did it (only ever the actor of a
 * verified service delegation that PV itself bound to the request) and WHEN it happened.
 *
 * Stored in one reserved, host-assigned key of the row's `payload`, `pvAttribution`, folded in
 * before the HMAC exactly like `extensionName`, so the existing chain covers it (tamper-evident) and
 * the table is untouched (D1). Pure: the clock is injected, nothing here touches a database, a logger
 * or the request. Errors never carry the actor subject, the assertion id, the key id or a time value.
 */

export const PV_ATTRIBUTION_KEY = 'pvAttribution'

/** The closed set of typed, non-retryable rejection codes (also the log reason codes). */
export const ATTRIBUTION_REJECT_CODES = [
  'actor_id_invalid',
  'occurred_at_invalid',
  'reserved_payload_key',
  'delegation_org_mismatch',
  'actor_requires_delegation',
  'actor_mismatch',
  'occurred_at_mismatch',
  'occurred_at_unattested',
  'occurred_at_in_future',
  'occurred_at_too_old',
] as const

export type AttributionRejectCode = (typeof ATTRIBUTION_REJECT_CODES)[number]

/** Thrown before any transaction opens; a sender must classify it as "quarantine", never retry. */
export class ExtensionAuditAttributionRejectedError extends Error {
  readonly retryable = false
  constructor(readonly code: AttributionRejectCode) {
    super(`audit event attribution rejected: ${code}`)
    this.name = 'ExtensionAuditAttributionRejectedError'
  }
}

export type PvAttribution = {
  v: 1
  occurredAt?: string
  occurredAtSource?: 'delegation_signed' | 'extension'
  actor?: DelegationSnapshot['actor']
  delegatedBy?: DelegationSnapshot['delegatedBy']
}

export type AttributionInput = {
  orgId: string
  actorId?: unknown
  occurredAt?: unknown
  payload: Record<string, unknown>
}

const MAX_ACTOR_ID_BYTES = 256
const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})([.\d]{0,10})(Z|[+-]\d{2}:\d{2})$/
const FRACTION = /^\.\d{1,9}$/

function reject(code: AttributionRejectCode): never {
  throw new ExtensionAuditAttributionRejectedError(code)
}

function inRange(value: number, min: number, max: number): boolean {
  return value >= min && value <= max
}

/** The offset token (`Z` or `+hh:mm`) in minutes, or `undefined` when out of range. */
function offsetMinutesOf(designator: string): number | undefined {
  if (designator.startsWith('Z')) return 0
  const hours = Number(designator.slice(1, 3))
  const minutes = Number(designator.slice(4, 6))
  if (hours > 23 || minutes > 59) return undefined
  return (designator.startsWith('-') ? -1 : 1) * (hours * 60 + minutes)
}

type DateParts = [number, number, number, number, number, number]

function validParts([year, month, day, hour, minute, second]: DateParts): boolean {
  if (!inRange(month, 1, 12)) return false
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return inRange(day, 1, daysInMonth) && hour <= 23 && minute <= 59 && second <= 59
}

/** A strict ISO-8601 instant with an explicit offset, to epoch milliseconds, or `undefined`. */
function parseInstantMs(value: string): number | undefined {
  const match = ISO_INSTANT.exec(value)
  if (!match) return undefined
  const parts = match.slice(1, 7).map(Number) as DateParts
  const fraction = match[7] ?? ''
  if (fraction !== '' && !FRACTION.test(fraction)) return undefined
  const offset = offsetMinutesOf(match[8] ?? 'Z')
  if (offset === undefined || !validParts(parts)) return undefined
  const [year, month, day, hour, minute, second] = parts
  const millis = Number(fraction.slice(1).padEnd(3, '0').slice(0, 3))
  return Date.UTC(year, month - 1, day, hour, minute, second, millis) - offset * 60_000
}

function readActorId(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > MAX_ACTOR_ID_BYTES
  ) {
    return reject('actor_id_invalid')
  }
  return value
}

function readOccurredAtMs(value: unknown): number | undefined {
  if (value === undefined) return undefined
  const parsed = typeof value === 'string' ? parseInstantMs(value) : undefined
  return parsed === undefined ? reject('occurred_at_invalid') : parsed
}

function checkActor(actorId: string | undefined, ambient: DelegationSnapshot | undefined): void {
  if (actorId === undefined) return
  if (ambient === undefined) reject('actor_requires_delegation')
  else if (ambient.actor.subject !== actorId) reject('actor_mismatch')
}

type EffectiveTime = { ms: number; source: 'delegation_signed' | 'extension' } | undefined

/** Design 3.4 / D3: the signed `occ` wins; an unsigned time on a delegated request is the
 * extension's word and so stays close to now; a non-delegated time is first-party code's own. */
function effectiveTime(
  givenMs: number | undefined,
  ambient: DelegationSnapshot | undefined
): EffectiveTime {
  const signed = ambient?.occurredAtSeconds
  if (signed !== undefined) {
    if (givenMs !== undefined && Math.floor(givenMs / 1000) !== signed) {
      reject('occurred_at_mismatch')
    }
    return { ms: givenMs ?? signed * 1000, source: 'delegation_signed' }
  }
  if (givenMs === undefined) return undefined
  return { ms: givenMs, source: 'extension' }
}

function checkTime(time: EffectiveTime, ambient: DelegationSnapshot | undefined, nowMs: number) {
  if (time === undefined) return
  // The route's own window for a signed `occ` was enforced in S1; here only the hard cap applies,
  // so a legitimate request is never rejected for the seconds that passed since verification.
  const hard = classifyOccurrence({
    occurredAtMs: time.ms,
    nowMs,
    maxAgeSeconds: OCCURRED_AT_MAX_AGE_SECONDS,
  })
  if (hard === 'future') reject('occurred_at_in_future')
  if (hard === 'too_old') reject('occurred_at_too_old')
  if (ambient !== undefined && time.source === 'extension') {
    const unattested = classifyOccurrence({
      occurredAtMs: time.ms,
      nowMs,
      maxAgeSeconds: OCCURRED_AT_UNATTESTED_MAX_PAST_SECONDS,
    })
    if (unattested === 'too_old') reject('occurred_at_unattested')
  }
}

/**
 * Validates the attribution inputs against the ambient (host-bound) delegation and builds the
 * `pvAttribution` value, or `undefined` when there is nothing to record (no delegated request and no
 * `occurredAt`: the payload, HMAC input and fingerprint stay byte-identical to before 71.4, D7).
 */
export function resolveAttribution(
  input: AttributionInput,
  ambient: DelegationSnapshot | undefined,
  nowMs: number
): PvAttribution | undefined {
  const actorId = readActorId(input.actorId)
  const givenMs = readOccurredAtMs(input.occurredAt)
  if (Object.hasOwn(input.payload, PV_ATTRIBUTION_KEY)) reject('reserved_payload_key')
  if (ambient !== undefined && ambient.orgId !== input.orgId) reject('delegation_org_mismatch')
  checkActor(actorId, ambient)
  const time = effectiveTime(givenMs, ambient)
  checkTime(time, ambient, nowMs)
  if (ambient === undefined && time === undefined) return undefined
  return {
    v: 1,
    ...(time === undefined
      ? {}
      : { occurredAt: new Date(time.ms).toISOString(), occurredAtSource: time.source }),
    ...(ambient === undefined
      ? {}
      : {
          actor: { ...ambient.actor },
          delegatedBy: { ...ambient.delegatedBy },
        }),
  }
}

/**
 * The part of the idempotency content fingerprint that attribution contributes: the effective time
 * and the effective actor (provider, subject, attestation). Deliberately NOT `delegatedBy`, the
 * assertion id, the kid, the reason or the user id: a retry arrives with a fresh assertion and must
 * still replay (AC-5). `undefined` when there is no attribution, so pre-71.4 fingerprints hold.
 */
export function attributionFingerprintPart(
  attribution: PvAttribution | undefined
): Record<string, unknown> | undefined {
  if (attribution === undefined) return undefined
  return {
    ...(attribution.occurredAt === undefined ? {} : { occurredAt: attribution.occurredAt }),
    ...(attribution.actor === undefined
      ? {}
      : {
          actor: {
            provider: attribution.actor.provider,
            subject: attribution.actor.subject,
            attestation: attribution.actor.attestation,
          },
        }),
  }
}
