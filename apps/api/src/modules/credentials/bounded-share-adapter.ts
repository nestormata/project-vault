import { eq } from 'drizzle-orm'
import type { Tx } from '@project-vault/db'
import { credentials } from '@project-vault/db/schema'
import { normalizeFieldKey } from '@project-vault/shared'
import { fieldMetaForResponse } from './field-set.js'
import { revealCurrentValue, selectCurrentVersionMeta } from './service.js'

/**
 * Story 20.5 AC-3: the `credential` adapter for architecture.md's Scoped/Bounded Sharing
 * Contract (decided by Story 20.4). Exactly the three functions the contract requires —
 * `attributeKeys`, `serializeBounded`, `resourceExists` — each RLS/org-scoped and read-only via
 * an already org-scoped `tx` the caller (the `credential-shares` sharing layer, never this
 * module) must establish first. None of these functions resolves org membership, opens its own
 * transaction, or accepts anything but an already-scoped `tx`. `credential` is the only populated
 * `resourceType` — this file intentionally does not generalize to a second resource type (out of
 * scope per the contract; see AC-3's failure example).
 *
 * These are thin wrappers over this module's existing `service.ts`/`field-set.ts` functions —
 * `revealCurrentValue` remains the only place that decrypts a credential's `encrypted_value`
 * envelope. `serializeBounded` is, in turn, the only place in this codebase a decrypted value may
 * cross from this adapter into the sharing layer, and only as the filtered/bounded result below —
 * never a raw internal shape, a live DB handle, or `SecureRouteContext`.
 */

async function loadCredentialProjectId(tx: Tx, resourceId: string): Promise<string | null> {
  const [row] = await tx
    .select({ projectId: credentials.projectId })
    .from(credentials)
    .where(eq(credentials.id, resourceId))
    .limit(1)
  return row?.projectId ?? null
}

/** AC-3: the declared attribute/field keys on the credential's current version — reuses the same
 *  `selectCurrentVersionMeta` + `fieldMetaForResponse` pair `getCredentialDetail`/`validateFieldKey`
 *  already use to answer this question, rather than re-deriving current-version resolution here. */
export async function attributeKeys(resourceId: string, tx: Tx): Promise<string[]> {
  const versionRow = await selectCurrentVersionMeta(tx, resourceId)
  if (!versionRow) return []
  return fieldMetaForResponse(versionRow.schemaVersion, versionRow.fieldMeta).map((f) => f.key)
}

/** AC-3/AC-4: a read-only existence check scoped only by the already-org-scoped `tx` (RLS does
 *  the org filtering) — deliberately does not take or resolve a `projectId`, unlike this module's
 *  `credentialExistsInProject` (which serves a different, project-nested-route caller). */
export async function resourceExists(resourceId: string, tx: Tx): Promise<boolean> {
  const [row] = await tx
    .select({ id: credentials.id })
    .from(credentials)
    .where(eq(credentials.id, resourceId))
    .limit(1)
  return Boolean(row)
}

export type BoundedField = { key: string; value: string; sensitive: boolean }

export type SerializeBoundedResult =
  | { status: 'not_found' }
  | { status: 'ok'; kind: 'value'; value: string }
  | { status: 'ok'; kind: 'fields'; fields: BoundedField[] }

function isIncluded(
  attributeKeysFilter: string[] | null,
  key: string,
  sensitive: boolean
): boolean {
  // Story 20.5 AC-2 (sensitivity-default-exclusion): `null` means "all non-sensitive attributes"
  // — a sensitive attribute is included only when its key was named explicitly (naming = consent,
  // regardless of sensitivity).
  //
  // Bugfix (post-implementation review): `attributeKeysFilter` is always persisted/normalized via
  // `normalizeFieldKey` (trim + NFC + lowercase — see `effectiveAttributeKeysForShare`/
  // `validateAttributeKeys`/`validateFieldKey` in service.ts), but `key` here comes from
  // `fieldMetaForResponse`'s declared field keys, which preserve whatever casing the credential's
  // fields were originally declared with (`fieldMetaForResponse`/`buildFieldMeta` never normalize
  // the stored key). Comparing a normalized filter against an un-normalized declared key would
  // silently exclude an explicitly-named attribute whose declared casing differs from how it was
  // typed into `attributeKeys`/`fieldKey` at share-creation time (e.g. declared `Password`, shared
  // as `password`) — normalize `key` on this side too so the comparison is exact regardless of
  // declared casing.
  return attributeKeysFilter ? attributeKeysFilter.includes(normalizeFieldKey(key)) : !sensitive
}

/** Extracted from `serializeBounded` purely to keep its own cyclomatic complexity under this
 *  repo's eslint threshold. Handles the "exactly one attribute key named" branch by reusing
 *  `revealCurrentValue`'s existing `?field=` path byte-for-byte (the same path Epic 17's single-
 *  `fieldKey`-scoped shares already exercise) rather than re-deriving its unknown-field/removed-
 *  field handling — this is what keeps a pre-existing single-`fieldKey` share's "field renamed/
 *  removed since creation -> not found" behavior unchanged by this story. Naming a key is always
 *  explicit consent, so no sensitivity filtering applies here. */
async function serializeBoundedSingleKey(
  resourceId: string,
  projectId: string,
  key: string,
  tx: Tx
): Promise<SerializeBoundedResult> {
  const revealed = await revealCurrentValue(tx, { credentialId: resourceId, projectId, field: key })
  if (revealed.status !== 'found') return { status: 'not_found' }
  if (revealed.kind === 'value') return { status: 'ok', kind: 'value', value: revealed.value }
  return {
    status: 'ok',
    kind: 'fields',
    fields: revealed.fields.map((f) => ({ key: f.key, value: f.value, sensitive: f.sensitive })),
  }
}

// Bugfix (post-implementation review): a non-null `attributeKeysFilter` is an explicit allow-list
// — named keys are never sensitivity-filtered (see `isIncluded`), so filtering it against the
// credential's currently-declared fields yields fewer fields than named keys precisely when one
// or more named keys no longer exist on the current version (renamed/removed since the share was
// created) — whether that is ALL of them or only SOME. That is exactly the "field renamed/removed"
// case `serializeBoundedSingleKey` already treats as `not_found` (-> `expired` to the caller) for
// a single named key — both filtered-result helpers below generalize the same treatment to their
// own shape (comparing counts, not just checking for a fully-empty result), rather than silently
// returning a 200 with a partial field array that gives the recipient fewer fields than the
// sharer named with no signal either party's request was only partially satisfiable. A `null`
// filter (whole-resource share) legitimately can yield an empty/excluded result (every field
// excluded by sensitivity-default-exclusion) — that is correct AC-2 behavior, not an error, so it
// is left alone in both helpers.
function filteredFieldsResult(
  attributeKeysFilter: string[] | null,
  fields: BoundedField[]
): SerializeBoundedResult {
  if (attributeKeysFilter && fields.length < attributeKeysFilter.length) {
    return { status: 'not_found' }
  }
  return { status: 'ok', kind: 'fields', fields }
}

/** Extracted from `serializeBoundedFiltered` purely to keep its own cyclomatic complexity under
 *  this repo's eslint threshold: the `kind === 'value'` branch (the credential collapses to a
 *  single field — legacy or single-field v2). Its key/sensitivity live in `field_meta`, never
 *  re-derived from the decrypted envelope, so the same inclusion rule `serializeBoundedFiltered`'s
 *  `fields` branch uses applies here too — this is the one case where a *whole-resource* share of
 *  a single-sensitive-field credential now excludes it by default (AC-2's one required behavior
 *  change), where previously it was always included. See `filteredFieldsResult` above for the
 *  not_found-vs-empty-ok distinction this mirrors for the single-field shape.
 *
 *  Bugfix (post-implementation review): this re-queries version metadata independently of
 *  `revealCurrentValue`'s own "current version" resolution, which already ran and decrypted
 *  `revealedValue` moments earlier in this same transaction. Under READ COMMITTED, a credential
 *  rotation that commits between those two reads could make this query resolve a *different*
 *  "current" version than the one `revealedValue` was actually decrypted from — pairing a stale
 *  value with a fresher (or vice versa) sensitivity flag would undermine AC-2's "never disclose an
 *  unnamed sensitive field" guarantee. Pinning this query to `revealedVersionNumber` (returned
 *  alongside `revealedValue` by the same `revealCurrentValue` call) and failing closed on any
 *  mismatch — treating it exactly like the field-renamed/removed case below — makes the two reads
 *  agree on which version they're describing, or refuse to serve a result at all. */
async function serializeBoundedSingleFieldValue(
  resourceId: string,
  attributeKeysFilter: string[] | null,
  revealedValue: string,
  revealedVersionNumber: number,
  tx: Tx
): Promise<SerializeBoundedResult> {
  const versionRow = await selectCurrentVersionMeta(tx, resourceId)
  // Fail closed, unconditionally (not routed through `filteredFieldsResult`, whose null-filter
  // branch treats an empty result as legitimate) — a version mismatch means this reveal can't be
  // trusted at all, regardless of what was named, so it is always `not_found`, never a "correctly
  // filtered down to nothing" `ok`.
  if (versionRow?.versionNumber !== revealedVersionNumber) {
    return { status: 'not_found' }
  }
  const [meta] = fieldMetaForResponse(versionRow.schemaVersion, versionRow.fieldMeta)
  if (!meta || !isIncluded(attributeKeysFilter, meta.key, meta.sensitive)) {
    return filteredFieldsResult(attributeKeysFilter, [])
  }
  // Bugfix (review patch): the credential collapsed to a single field, which happens to match one
  // of the named keys — but if `attributeKeysFilter` named MORE than one key, only 1 of N was
  // actually satisfiable here, the same "not all named keys survived" case `filteredFieldsResult`
  // already fails closed on for the multi-field shape (comparing `fields.length` against
  // `attributeKeysFilter.length`). A `null` filter (whole-resource share) legitimately resolves to
  // this one field as a bare value; a true single-key filter never reaches this function at all —
  // `serializeBounded` routes any `attributeKeysFilter.length === 1` request through
  // `serializeBoundedSingleKey` instead — so only a multi-key filter that this single field only
  // partially satisfies must fail closed here instead of silently disclosing 1 of N.
  if (attributeKeysFilter && attributeKeysFilter.length > 1) {
    return { status: 'not_found' }
  }
  return { status: 'ok', kind: 'value', value: revealedValue }
}

/** Extracted from `serializeBounded` for the same complexity-ceiling reason as
 *  `serializeBoundedSingleKey` above: handles the whole-resource (`attributeKeys: null`) and
 *  multi-key-allow-list branches, both of which need `revealCurrentValue`'s full (non-`field`-
 *  scoped) result filtered by the same sensitivity-default-exclusion rule (AC-2). */
async function serializeBoundedFiltered(
  resourceId: string,
  projectId: string,
  attributeKeysFilter: string[] | null,
  tx: Tx
): Promise<SerializeBoundedResult> {
  const revealed = await revealCurrentValue(tx, { credentialId: resourceId, projectId })
  if (revealed.status !== 'found') return { status: 'not_found' }

  if (revealed.kind === 'fields') {
    const fields = revealed.fields
      .filter((f) => isIncluded(attributeKeysFilter, f.key, f.sensitive))
      .map((f) => ({ key: f.key, value: f.value, sensitive: f.sensitive }))
    return filteredFieldsResult(attributeKeysFilter, fields)
  }

  return serializeBoundedSingleFieldValue(
    resourceId,
    attributeKeysFilter,
    revealed.value,
    revealed.versionNumber,
    tx
  )
}

/**
 * AC-2/AC-3: the bounded, sensitivity-filtered serialization of a credential's current version.
 * `attributeKeys: null` applies sensitivity-default-exclusion (only non-sensitive attributes);
 * a non-null list is an explicit allow-list — fields named there are included whether sensitive
 * or not, restricted to fields that actually exist on the current version.
 */
export async function serializeBounded(
  resourceId: string,
  attributeKeysFilter: string[] | null,
  tx: Tx
): Promise<SerializeBoundedResult> {
  const projectId = await loadCredentialProjectId(tx, resourceId)
  if (!projectId) return { status: 'not_found' }

  const singleKey = attributeKeysFilter?.length === 1 ? attributeKeysFilter[0] : undefined
  if (singleKey) return serializeBoundedSingleKey(resourceId, projectId, singleKey, tx)

  return serializeBoundedFiltered(resourceId, projectId, attributeKeysFilter, tx)
}
