import { z } from 'zod/v4'
import { CapabilityId } from '../constants/capability-ids.js'

// Story 23.7 AC-1/AC-2 — GET /api/v1/capabilities's response shape: a boolean map only, keyed by
// the closed CapabilityId registry. Deliberately excludes `reasonCode`/`message` — those are
// extension-authored, per-denial-moment text (Story 23.3 AC-4), not data for a per-screen-load
// cosmetic map fetched by every authenticated user on every render. Exactly one top-level key
// (`capabilities`) — no posture, no gate-liveness flag, no counters (AC-2's "no posture" rule).
const capabilityIdValues = Object.values(CapabilityId) as [string, ...string[]]

export const CapabilityMapSchema = z
  .object(Object.fromEntries(capabilityIdValues.map((id) => [id, z.boolean()])))
  .meta({ id: 'CapabilityMap' })

export const CapabilitiesResponseSchema = z
  .object({ data: z.object({ capabilities: CapabilityMapSchema }) })
  .meta({ id: 'CapabilitiesResponse' })

export type CapabilityMap = z.infer<typeof CapabilityMapSchema>
