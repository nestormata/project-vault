/**
 * Story 37.1 — a host-provided service, same directionality as `OrgAuthorizationHost`
 * (Story 23.9/23.11): PV implements `checkProjectMembership()` and hands a bound instance to the
 * extension via `HostServices` (see `host-services.ts`). It does NOT belong in `ExtensionHooks`
 * alongside the extension-implemented hooks — this is PV answering a question for the extension,
 * not the extension implementing behavior for PV.
 *
 * This is a **new, structurally separate hook** from `orgAuthorization`, not an extended
 * `OrgAuthorizationCheckContext` — `checkMembership()`'s existing type is a published contract
 * three real call sites and Story 23.11's enumeration-risk fix already depend on; widening it
 * would change what "authorized" means for every existing org-scoped caller, not just new
 * project-scoped ones. A dedicated hook keeps `orgAuthorization`'s contract, audit trail, and
 * rate-limit budget completely untouched.
 *
 * `minimumRole` reuses PV's own existing internal role enum (`owner` > `admin` > `member` >
 * `viewer`), same as `OrgAuthorizationCheckContext` — this hook answers only "is this identity
 * currently a member of this project (or its ambient org, via the org-owner/admin bypass) with
 * at least this role," never a capability/tier question (that is `CapabilityGate`'s job).
 *
 * Story 23.11 AC3's rationale, adapted from the org axis to the project axis (see
 * `OrgAuthorizationCheckContext`'s doc comment for the verbatim original) — `organizationId` is
 * deliberately NOT a field here either: the org this check runs against is always the host's own
 * ambient per-request context (`getRequestContext().orgId`), never a caller-supplied value. This
 * closes the same cross-tenant membership-enumeration risk for the project axis: an extension
 * cannot ask "is identity X a member of project Y" for an arbitrary org's project Y it has no
 * legitimate involvement in, because there is no field through which to supply a foreign org.
 * `projectId` DOES stay an explicit, caller-supplied parameter — there is no ambient
 * project-bearing context to resolve it from (`RequestContext` carries only `{ orgId, userId }`,
 * and there is no single project-bearing preHandler the way `authenticate` is the one
 * org-bearing preHandler; PV's own project routes resolve `projectId` per-route from the URL
 * param). The host validates the supplied `projectId` actually belongs to the ambient org before
 * ever answering — see `apps/api/src/lib/project-authorization.ts`'s
 * `resolveProjectAuthorizationOutcome()` for the enforcement. `viewerIdentityId` stays explicit
 * too, exactly as it does on `OrgAuthorizationCheckContext` — checking a *different* identity's
 * role within the extension's own, ambient-bound org/project remains a legitimate operation this
 * type does not restrict.
 */
export type ProjectAuthorizationCheckContext = {
  viewerIdentityId: string
  projectId: string
  minimumRole: 'owner' | 'admin' | 'member' | 'viewer'
}

/**
 * Never thrown to the caller — every failure mode this hook can encounter (missing ambient
 * context, an out-of-enum `minimumRole`, a `projectId` that does not belong to the ambient org,
 * no qualifying membership, or an internal resolution error) resolves to one of these three
 * outcomes.
 *
 * `reasonCode` is diagnostic text only, not a stable, pattern-matchable contract — only the
 * `outcome` discriminant values (`'authorized' | 'denied' | 'error'`) are part of this type's
 * contract. A future wording change to a `reasonCode` string is not a breaking change. In
 * particular, "no membership row," "membership row present but role too low," and "`projectId`
 * belongs to a different org (or does not exist)" ALL collapse to the identical `reasonCode`
 * (`'not-a-project-member'`) — deliberately, to avoid a membership/tenancy-existence oracle via
 * `reasonCode`, mirroring `OrgAuthorizationOutcome`'s own `'not-a-member'` collapsing.
 */
export type ProjectAuthorizationOutcome =
  | { outcome: 'authorized' }
  | { outcome: 'denied'; reasonCode: string }
  | { outcome: 'error'; reasonCode: string }

/**
 * Request-scoped and re-evaluated on every call — never cached or memoized across calls, even
 * though the bound function reference itself is constructed once, at extension-load time
 * (`loader.ts`'s `buildHostServices()`), and reused across every subsequent request.
 */
export type ProjectAuthorizationHost = {
  checkProjectMembership(
    context: ProjectAuthorizationCheckContext
  ): Promise<ProjectAuthorizationOutcome>
}
