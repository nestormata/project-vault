import { z } from 'zod/v4'
import { sql, type SQL } from 'drizzle-orm'
import { auditLogEntries } from '@project-vault/db/schema'
import { PV_ATTRIBUTION_KEY } from './extension-attribution.js'

/**
 * Story 71.10 — the READER side of the 71.4 `pvAttribution` payload key.
 *
 * Readers (search, export) select ONLY the `pvAttribution` sub-object (never the free-form
 * `payload`), run it through `parsePvAttribution`, and expose a deliberately small public shape:
 * the external actor (provider, subject, how sure PV is, why) and the occurrence time. `delegatedBy`
 * (kid, issuer, assertion id) and the stored `userId` are operator data and are never exposed.
 *
 * Provider and subject are external, attacker-influenced text (a compromised issuer, design threat
 * 15), so the parser fails CLOSED: anything unexpected yields `undefined` and the row renders exactly
 * like a pre-71 row. It never throws and never logs the value.
 *
 * Versioning: the stored shape is `v: 1`. A later `v: 2` needs a parser bump here AND a failing test
 * first, otherwise v2 rows silently render as unattributed.
 */

export const ATTRIBUTION_PROVIDER_MAX_CHARS = 64
export const ATTRIBUTION_SUBJECT_MAX_CHARS = 256

/** Unsafe code points: C0/C1 controls (incl. U+0000-001F and U+007F), the zero-width and bidi marks
 * (U+200B-200F) and the bidi embedding/override/isolate controls (U+202A-202E, U+2066-2069). A bidi
 * control can visually spoof a PV user's name, so the whole attribution is rejected when one is
 * present. Range checks, not a regex literal, so the source holds no invisible characters. */
const UNSAFE_RANGES: readonly (readonly [number, number])[] = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
  // Other invisible or line-breaking marks that can hide or spoof text, plus lone surrogates (never
  // valid in jsonb, so a filter value holding one would otherwise fail the query with a 500).
  [0x061c, 0x061c],
  [0x2028, 0x2029],
  [0x2060, 0x2064],
  [0xd800, 0xdfff],
  [0xfeff, 0xfeff],
]

function hasUnsafeCodePoint(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (UNSAFE_RANGES.some(([low, high]) => code >= low && code <= high)) return true
  }
  return false
}

export function isSafeExternalText(value: string, maxChars: number): boolean {
  return value.length > 0 && value.length <= maxChars && !hasUnsafeCodePoint(value)
}

const SafeProvider = z
  .string()
  .refine((value) => isSafeExternalText(value, ATTRIBUTION_PROVIDER_MAX_CHARS))
const SafeSubject = z
  .string()
  .refine((value) => isSafeExternalText(value, ATTRIBUTION_SUBJECT_MAX_CHARS))

const StoredActorSchema = z
  .object({
    provider: SafeProvider,
    subject: SafeSubject,
    attestation: z.enum(['pv_verified', 'issuer_attested']),
    reason: z.enum(['unlinked', 'not_current_member']).nullable(),
  })
  .refine((actor) => (actor.attestation === 'pv_verified') === (actor.reason === null))

const StoredAttributionSchema = z.object({
  v: z.literal(1),
  occurredAt: z.string().min(1).max(64).optional(),
  occurredAtSource: z.enum(['delegation_signed', 'extension']).optional(),
  actor: StoredActorSchema.optional(),
})

export type PublicAttributionActor = {
  kind: 'pv_verified' | 'issuer_attested'
  provider: string
  subject: string
  reason: 'unlinked' | 'not_current_member' | null
}

export type PublicAttribution = {
  actor?: PublicAttributionActor
  occurredAt?: string
  occurredAtSource?: 'delegation_signed' | 'extension'
}

/** Strict, fail-closed parse of a stored `pvAttribution`; `undefined` means "show as a legacy row". */
export function parsePvAttribution(raw: unknown): PublicAttribution | undefined {
  const parsed = StoredAttributionSchema.safeParse(raw)
  if (!parsed.success) return undefined
  const { actor, occurredAt, occurredAtSource } = parsed.data
  const result: PublicAttribution = {
    ...(actor
      ? {
          actor: {
            kind: actor.attestation,
            provider: actor.provider,
            subject: actor.subject,
            reason: actor.reason,
          },
        }
      : {}),
    ...(occurredAt === undefined ? {} : { occurredAt }),
    ...(occurredAtSource === undefined ? {} : { occurredAtSource }),
  }
  return Object.keys(result).length === 0 ? undefined : result
}

/** The jsonb SUB-PATH projection (D1): never the whole `payload`. Only `extension` rows carry the
 * host-assigned key (71-4), so any other row yields NULL and renders exactly as before. */
export const pvAttributionProjection: SQL<unknown> = sql`CASE WHEN ${auditLogEntries.actorType} = 'extension' THEN ${auditLogEntries.payload} #> ${sql.raw(
  `'{${PV_ATTRIBUTION_KEY}}'`
)} END`

/** D3: exact, case-sensitive, parameterised containment match on provider + subject, extension rows only. */
export function actorAttributionCondition(provider: string, subject: string): SQL {
  const needle = JSON.stringify({
    [PV_ATTRIBUTION_KEY]: { actor: { provider, subject } },
  })
  return sql`(${auditLogEntries.actorType} = 'extension' AND ${auditLogEntries.payload} @> ${needle}::jsonb)`
}

/** D3: provider + subject both-or-neither, non-empty, within the write-time caps, and never combined
 * with `actorId` (the PV-user filter), so the two filters stay distinguishable. */
export function isValidActorFilter(input: {
  actorId?: string
  actorProvider?: string
  actorSubject?: string
}): boolean {
  const { actorId, actorProvider, actorSubject } = input
  if (actorProvider === undefined && actorSubject === undefined) return true
  if (actorProvider === undefined || actorSubject === undefined) return false
  if (actorId !== undefined) return false
  // The same safety rule as the reader: a value the parser would reject can never match a row, and
  // NUL or a lone surrogate would make the jsonb cast fail (500), so both answer 422 instead.
  return (
    isSafeExternalText(actorProvider, ATTRIBUTION_PROVIDER_MAX_CHARS) &&
    isSafeExternalText(actorSubject, ATTRIBUTION_SUBJECT_MAX_CHARS)
  )
}
