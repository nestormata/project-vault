/**
 * Story 20.12 — `CredentialSharingHost` is the eighth `HostServices` field (see
 * `host-services.ts`), same directionality as `AuditEventSourceHost`/`OrgAuthorizationHost`/
 * `PvMonitoringHost`/etc.: PV implements every method here and hands a bound instance to the
 * extension via `HostServices`. It does NOT belong in `ExtensionHooks` — this is PV answering/
 * servicing the extension, not the extension implementing behavior for PV.
 *
 * **No parallel reimplementation (AC2/AC3/AC4/AC6).** Every method here is a thin closure over
 * PV's real, already-shipped Epic 17/20.4/20.5 `credential-shares` service-layer functions
 * (`apps/api/src/modules/credential-shares/service.ts`, `external-service.ts`) — no new SQL, no
 * new validation logic, no new cap-bucket implementation, no parallel schema. `packages/
 * extension-api` itself stays type-only/zero-DB — these types describe the contract; the runtime
 * implementation lives entirely in `apps/api/src/lib/credential-sharing-host.ts`.
 *
 * **Directionality split by invocation context (Design Decision 2), not uniform across all five
 * methods:**
 * - `createExternalShare`/`revokeShare`/`supersedeSharesForRotation` are out-of-request,
 *   caller-attributed actions: they take an explicit `organizationId` (mirroring
 *   `PvMonitoringHost#applyHealthCheckResult`/`cleanupProjectMonitoring`'s own split), since there
 *   is no anonymous-redemption precedent to inherit from for these three.
 * - `findShareByToken`/`revealShare` take ONLY a `rawToken: string` — no `organizationId` field
 *   anywhere on their parameter types. This is not a design choice this story invents: it is
 *   inherited unchanged from Epic 17.2's already-shipped, already-reviewed anonymous-redemption
 *   boundary (`external-service.ts#findExternalShareByTokenHash`/`revealExternalShare`), which
 *   resolves the org from the token itself via `adminLookupByTokenHash` -> `withOrg(row.orgId,
 *   ...)`. See AC3.
 *
 * **Audit attribution (Design Decision A, Nestor-confirmed 2026-09-20).**
 * `createExternalShare`/`revokeShare`/`supersedeSharesForRotation` attribute via a resolved
 * `machine_user` actor (`writeMachineAuditEntry`) — never a caller-supplied PV user id, never a
 * new `actorType: 'extension'` category, never a silent fallback to system-actor. The host fails
 * closed (`CredentialSharingNoMachineUserError`) if the calling extension's org has no mapped PV
 * machine-user. `findShareByToken`/`revealShare` are unaffected — their underlying functions
 * already use system-actor audit unchanged (no PV-authenticated human OR machine caller exists for
 * an anonymous token redemption).
 *
 * **Rate limiting (AC5/AC5b).** Every method goes through a per-extension in-flight cap
 * (`CredentialSharingRateLimitedError`), a distinct, dedicated budget from every other hook's own
 * (never shared). `findShareByToken`/`revealShare` are ADDITIONALLY rate-limited per
 * `organizationId` (resolved from the token) via a real per-org token-bucket
 * (`CredentialSharingOrgRateLimitedError`) — Nestor-confirmed Design Decision B, a genuine
 * in-process analogue to `external-access-routes.ts`'s IP-scoped backstop, not merely the
 * per-extension in-flight cap.
 *
 * **Error classes.** Errors PV's own wrapped functions already throw propagate UNCHANGED across
 * this hook boundary. This module adds three NEW, hook-specific error classes for the three new
 * failure modes this story itself introduces: per-extension rate-limiting, per-org rate-limiting,
 * and fail-closed machine-user-attribution absence.
 */

// ---------------------------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------------------------

/**
 * AC5 — thrown by every method when the calling extension's per-extension in-flight accounting
 * key is already at its concurrency cap (`CREDENTIAL_SHARING_HOST_MAX_IN_FLIGHT_PER_EXTENSION`).
 * This budget is distinct from `monitoring`'s own and from every other hook's own — never shared.
 */
export class CredentialSharingRateLimitedError extends Error {
  readonly code = 'credential_sharing_rate_limited'

  constructor(methodName: string) {
    super(
      `HostServices.credentialSharing.${methodName}() rejected: per-extension in-flight cap reached`
    )
    this.name = 'CredentialSharingRateLimitedError'
  }
}

/**
 * AC5b (Design Decision B, Nestor-confirmed) — thrown by `findShareByToken`/`revealShare` when
 * the resolved `organizationId`'s per-org token-bucket is exhausted. Distinct from
 * `CredentialSharingRateLimitedError` above: this protects against a token-guessing attack
 * against one org, not runaway per-extension concurrency.
 */
export class CredentialSharingOrgRateLimitedError extends Error {
  readonly code = 'credential_sharing_org_rate_limited'

  constructor(methodName: string) {
    super(`HostServices.credentialSharing.${methodName}() rejected: per-org rate limit exceeded`)
    this.name = 'CredentialSharingOrgRateLimitedError'
  }
}

/**
 * Design Decision A (Nestor-confirmed) — thrown by `createExternalShare`/`revokeShare`/
 * `supersedeSharesForRotation` when the calling extension's org has no mapped PV machine-user to
 * attribute the audit write to. Fail closed: never falls back to an unattributed or system-actor
 * write.
 */
export class CredentialSharingNoMachineUserError extends Error {
  readonly code = 'credential_sharing_no_machine_user'

  constructor(methodName: string) {
    super(
      `HostServices.credentialSharing.${methodName}() rejected: no PV machine-user is mapped for the calling extension's org`
    )
    this.name = 'CredentialSharingNoMachineUserError'
  }
}

// ---------------------------------------------------------------------------------------------
// Shared data shapes — plain, serializable mirrors of `credential_shares` rows. Deliberately
// independent of `@project-vault/db`'s schema types (extension-api stays zero-DB-access).
// `tokenHash` is NEVER exposed here — only the raw, one-time token on `createExternalShare`'s own
// `ok` result (AC2's "returned exactly once" contract).
// ---------------------------------------------------------------------------------------------

export type CredentialSharingShareStatus =
  'active' | 'viewed' | 'revoked' | 'expired' | 'superseded'

export type CredentialSharingShareRecord = {
  id: string
  orgId: string
  credentialId: string
  fieldKey: string | null
  attributeKeys: string[] | null
  recipientType: 'user' | 'external'
  recipientUserId: string | null
  recipientEmail: string | null
  singleUse: boolean
  createdAt: string
  expiresAt: string
  revokedAt: string | null
  supersededAt: string | null
  firstViewedAt: string | null
  viewCount: number
  status: CredentialSharingShareStatus
}

// ---------------------------------------------------------------------------------------------
// createExternalShare (AC2) — out-of-request, explicit organizationId.
// ---------------------------------------------------------------------------------------------

/** AC2 — the same shape `CreateExternalShareInput` already has, minus `sharedByUserId` (Design
 * Decision A: attribution is resolved by the host itself, never caller-supplied). */
export type CredentialSharingCreateExternalShareParams = {
  organizationId: string
  projectId: string
  credentialId: string
  recipientEmail: string
  /** ISO-8601 string — the host converts to a `Date` internally. */
  expiresAt: string
  fieldKey?: string
  attributeKeys?: string[] | null
}

/** The non-`'ok'` failure-status vocabulary for creating an external share — single source of
 * truth, mirrored back into apps/api's own internal `CreateExternalShareResult`
 * (`external-service.ts` imports this type rather than redeclaring the literal union) so the two
 * no longer duplicate the same 7-variant union verbatim (Story 20.12 code review: this was a
 * jscpd clone). */
export type CredentialShareCreationErrorStatus =
  | { status: 'credential_not_found' }
  | { status: 'credential_archived' }
  | { status: 'unknown_field_key'; field: string }
  | { status: 'ambiguous_share_scope' }
  | { status: 'too_many_attribute_keys' }
  | { status: 'expires_at_invalid'; reason: 'past' | 'too_far_in_future' }
  | { status: 'cap_exceeded' }

export type CredentialSharingCreateExternalShareResult =
  | CredentialShareCreationErrorStatus
  | { status: 'ok'; share: CredentialSharingShareRecord; token: string }

// ---------------------------------------------------------------------------------------------
// findShareByToken / revealShare (AC3) — no organizationId field anywhere on these parameter
// types. Org resolves from the token itself, inherited unchanged from Epic 17.2.
// ---------------------------------------------------------------------------------------------

export type CredentialSharingFindShareByTokenResult =
  | { status: 'not_found' }
  | {
      status: 'ok'
      share: CredentialSharingShareRecord
      credentialName: string
      credentialProjectId: string
      sharedByDisplayName: string
    }

export type CredentialSharingRevealResult =
  | { status: 'not_found' }
  | { status: 'expired' }
  | { status: 'already_viewed' }
  | { status: 'revoked' }
  | {
      status: 'ok'
      share: CredentialSharingShareRecord
      value: string
      valueFormat: 'scalar' | 'fields'
      fieldKey: string | null
    }

// ---------------------------------------------------------------------------------------------
// revokeShare / supersedeSharesForRotation (AC4) — out-of-request, explicit organizationId.
// ---------------------------------------------------------------------------------------------

export type CredentialSharingRevokeShareParams = {
  organizationId: string
  projectId: string
  credentialId: string
  shareId: string
}

/** AC4 — idempotent-no-op semantics preserved unchanged: revoking an already-terminal share
 * returns its current state, not an error. */
export type CredentialSharingRevokeShareResult =
  | { status: 'not_found' }
  | { status: 'ok'; share: CredentialSharingShareRecord; alreadyTerminal: boolean }

export type CredentialSharingSupersedeSharesForRotationParams = {
  organizationId: string
  credentialId: string
  targetFields: string[] | null
  rotationId: string
}

export type CredentialSharingSupersedeSharesForRotationResult = {
  supersededShares: CredentialSharingShareRecord[]
}

// ---------------------------------------------------------------------------------------------
// listSharesForCredential / listSharesForOrganization (AC8/AC9/AC10) — thin, out-of-request,
// explicit-organizationId read/list methods, mirroring createExternalShare/revokeShare/
// supersedeSharesForRotation's own out-of-request directionality split (never
// findShareByToken/revealShare's org-resolves-from-token shape, since these two take an
// org-scoped caller up front). No `sharedByUserId` field anywhere on either params type (Design
// Decision D, Nestor-confirmed) — the facade has no PV-session identity to scope "my own shares
// only" by, and always returns admin-equivalent results (every share in scope).
// ---------------------------------------------------------------------------------------------

/** AC8 — mirrors `apps/api`'s own `ListSharesForCredentialParams` minus `orgId` (renamed
 * `organizationId` for facade consistency, matching `createExternalShare`'s own precedent) and
 * minus `sharedByUserId` (Design Decision D, dropped entirely). */
export type CredentialSharingListParams = {
  organizationId: string
  credentialId: string
  status?: CredentialSharingShareStatus
  limit?: number
  offset?: number
}

/** AC9 — org-scoped only, no `credentialId` filter: "all outstanding shares this extension's org
 * has created," not just one credential's. */
export type CredentialSharingOrgListParams = {
  organizationId: string
  status?: CredentialSharingShareStatus
  limit?: number
  offset?: number
}

/** AC8/AC9 — the same `items`+`total` pagination shape the existing `GET .../shares` route
 * already returns (`routes.ts` line ~725). An unmatched/empty scope (e.g. a `credentialId`
 * outside the caller's org) returns `{ status: 'ok', items: [], total: 0 }`, not a distinguishable
 * not-found — the underlying query's own existing behavior, not invented by this story.
 *
 * AC10 — items are `CredentialSharingShareRecord` (Drizzle-internals-free, never `apps/api`'s own
 * `CredentialShareRow` directly), the same sibling type `createExternalShare`/`revealShare` etc.
 * already use — no separate `CredentialShareSummary` alias, since the shape is already identical
 * (SonarQube S6564: a same-shape alias with no distinct meaning is redundant indirection, not a
 * real sibling type). */
export type CredentialSharingListResult = {
  status: 'ok'
  items: CredentialSharingShareRecord[]
  total: number
}

/**
 * Story 20.12 — the real `HostServices.credentialSharing` field. See this module's doc comment
 * for the full directionality/error-class/attribution/rate-limiting rationale.
 *
 * Story 20.13 AC8/AC9/AC11 — `listSharesForCredential`/`listSharesForOrganization` are the sixth
 * and seventh methods, added by this story. Both are out-of-request, explicit-`organizationId`
 * read/list operations (same directionality as `createExternalShare`/`revokeShare`/
 * `supersedeSharesForRotation`), thin closures over `apps/api`'s `service.ts` query pair (one
 * pre-existing, one genuinely new — see `service.ts`'s own doc comments), routed through the same
 * `callOutOfRequestMethod` per-extension in-flight wrapper every other method already uses (AC11)
 * — no new rate-limit bucket, no machine-user audit attribution (Design Decision E: a read
 * produces no attributed write, so it has no equivalent requirement).
 */
export type CredentialSharingHost = {
  createExternalShare(
    params: CredentialSharingCreateExternalShareParams
  ): Promise<CredentialSharingCreateExternalShareResult>
  findShareByToken(rawToken: string): Promise<CredentialSharingFindShareByTokenResult>
  revealShare(rawToken: string): Promise<CredentialSharingRevealResult>
  revokeShare(
    params: CredentialSharingRevokeShareParams
  ): Promise<CredentialSharingRevokeShareResult>
  supersedeSharesForRotation(
    params: CredentialSharingSupersedeSharesForRotationParams
  ): Promise<CredentialSharingSupersedeSharesForRotationResult>
  listSharesForCredential(params: CredentialSharingListParams): Promise<CredentialSharingListResult>
  listSharesForOrganization(
    params: CredentialSharingOrgListParams
  ): Promise<CredentialSharingListResult>
}
