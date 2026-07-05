# Adversarial Review: Story 8.3 — Access Reports, Dormant Users & Audit PII Management

- **Date:** 2026-07-05
- **Reviewed file:** `_bmad-output/implementation-artifacts/8-3-access-reports-dormant-users-and-audit-pii-management.md`
- **Reviewer:** bmad-review-adversarial-general

## Findings

### Critical

- **[critical]** D2's event-replay set for historical access reports (`project.invitation_accepted`, `project.member_role_changed`, `project.member_removed`, `project.ownership_transferred`, `org.user_removed`, `org.user_deactivated`) contains **no event type that represents org-level membership creation for the founding/first owner**. Confirmed by reading `apps/api/src/modules/auth/service.ts:394`: registration writes `AuditEvent.PROJECT_INVITATION_ACCEPTED` when an invitation exists, but `AuditEvent.USER_REGISTERED` when it does not (i.e., for the org-creating owner) — and `USER_REGISTERED` is absent from D2's replay list entirely. Since D2 says org role is "simply whatever it was at the org-membership-creation event," and the founding owner's creation event isn't in the replay set, the historical path has no way to establish that the founding owner was ever an org member at any past `asOf` — the single most common user in every org (every org has exactly one founder) risks silently vanishing from every historical access report.

**Resolution:** D2's replay-event list now includes `user.registered` (`AuditEvent.USER_REGISTERED`) as an org-membership-creation event with `orgRole: "owner"`, confirmed against `insertRegistrationMemberships()`/`registerUser()` (`auth/service.ts:280-409`) and cited by line number. AC-2's edge cases and AC-28's test matrix now explicitly reference the founding-owner-visible-via-`user.registered` scenario.

- **[critical]** AC-2's own framing states the historical report must reconstruct "what a report generated on that date would have shown," but D4/AC-8 mandate that `displayName` is **always** resolved via a live, current-state join to `user_identity_tokens` for both the fast path and the historical path ("Both paths resolve `displayName`... Both paths return the exact same response shape"). This means a historical report for a date *before* a user was pseudonymized will show their **current** alias, not the real name that would actually have appeared in a report generated on that historical date — directly contradicting AC-2's "matches what a report generated on that date would have shown" framing. No AC or Dev Note acknowledges or resolves this contradiction between "historically accurate reconstruction" and "always-current PII resolution." (This is also the concurrent-pseudonymization-during-report-generation edge case: a report for a past `asOf`, generated seconds after a pseudonymize call completes, will retroactively show the alias for a period when the real name was actually in effect, with no test or AC covering this scenario at all.)

**Resolution:** D4 now has an explicit "Pseudonymization is always current-state, deliberately, even for historical reports" paragraph explaining why this is correct (pseudonymization is irreversible by design), and AC-2 is reworded so its "historically accurate" guarantee is scoped explicitly to access grants/roles only, not PII. AC-2 adds a new edge case ("historical `asOf` generated immediately after a pseudonymize call") that directly tests the previously-uncovered concurrent-pseudonymization scenario.

### High

- **[high]** D2 admits the exact payload shape of `project.invitation_accepted` — the single load-bearing grant signal for the entire event-replay mechanism — is "not yet finalized in this story's research" and must be "confirmed... at implementation time." Building AC-2's entire historical-reconstruction guarantee on an admittedly-unverified payload shape is a real implementation risk, not a documentation nit; if the actual shape differs from assumptions (e.g., `resourceId` doesn't resolve to a user the way described), AC-2 as written may not be implementable without a story-file correction mid-development.

**Resolution:** D2 now documents both confirmed `project.invitation_accepted` emission sites (`invitations/token-routes.ts:174-182` and `auth/service.ts:390-398`), their exact `resourceId`/`payload` shapes (grep-verified, no `role` field in either), and the join strategy needed to resolve the granted role via `project_invitations.roleToAssign` — no longer "to be confirmed at implementation time."

- **[high]** D2 describes `project.ownership_transferred` as having both a "removal side" (old owner loses access) and a "grant side" (new owner gains access), implying one audit event must yield two distinct per-`(orgId, userId, projectId)` triple mutations. The story never specifies this event's payload shape (e.g., whether it carries both an old-owner and new-owner user ID) or how the replay algorithm is meant to derive two state transitions from one event record. This is left completely unaddressed and could silently break replay correctness for any project that has ever changed ownership.

**Resolution:** D2 now cites the confirmed emission site (`projects/routes.ts:796-804`), the exact payload (`{ previousOwnerId, newOwnerId }`, `resourceId: projectId`), and specifies precisely how both state transitions (previous owner → `admin`, new owner → `owner`) are derived from the single event row.

- **[high]** D9's "accepted, not fixed" cross-org display-name bleed is framed as a data-consistency/UX trade-off, but it is functionally a tenant-isolation gap: Org A's owner can unilaterally and — per the DB-enforced `prevent_pseudonym_reversal()` trigger — **permanently** alter identity data that appears in Org B's compliance reports and audit exports, without Org B's knowledge, consent, or any visible breadcrumb in Org B tracing the change back to Org A's action. In a system that otherwise enforces strict per-org RLS isolation everywhere else, labeling this "accepted" understates the real risk that a careless or malicious Org A owner can degrade another tenant's compliance posture with a single API call.

**Resolution:** D9 now adds three concrete safeguards (blast-radius lookup, mandatory `confirmUserId` re-confirmation, audit-payload breadcrumb) rather than leaving the trade-off as pure documentation. See also the resolution for the next finding (5/6 share one fix) and finding 15.

- **[high]** No safeguard is proposed anywhere for the combination of (a) DB-enforced irreversibility of pseudonymization and (b) D9's cross-org blast radius: no confirmation step, no dual-control/second-approval, no rate-limit distinct from ordinary mutations, and no notification to affected other orgs. AC-17/AC-20 apply only the same owner-only authorization used for routine actions, despite this action's uniquely permanent, cross-tenant-impacting nature once D9 is factored in.

**Resolution:** new AC-17a ("Blast-Radius Disclosure and Explicit Re-Confirmation Required") requires a `confirmUserId` body field matching the target user before any mutation, and surfaces `otherAffectedOrgCount` in the response. AC-17/AC-21 updated accordingly; Task 6 gains subtasks 6.3/6.4 implementing the lookup and the confirmation gate.

- **[high]** Task 6.1 requires the pseudonymize logic be internally callable "within another transaction" for Story 8.4's future erasure flow, but no AC (17–22) or test task (6.5) actually exercises that internal, non-HTTP call path (e.g., invoked without a `SecureRouteContext`/`ctx.auth`). This is a stated interface requirement with zero corresponding test coverage — a real gap for a documented forward dependency.

**Resolution:** Task 6.1 now spells out the function signature (`tx` + plain IDs, no `SecureRouteContext`/`ctx.auth` dependency) and new Task 6.7 adds a dedicated internal-callability test exercising exactly that call path, referenced in AC-28's test matrix.

- **[high]** D2's fast-path condition ("`asOf` omitted, or resolves to 'now'") has no defined tolerance or equality rule. A client-supplied `asOf` timestamp will almost always be at least milliseconds behind server-processing time by the time it's evaluated, so it's unspecified whether an explicit `asOf` set to "the current time" takes the fast path or the historical path. This ambiguity risks flaky tests and inconsistent behavior right at the fast/historical boundary that AC-1 vs AC-2 depend on.

**Resolution:** D2 item 1 now defines the fast path as applying **only** when `asOf` is absent from the request entirely — never based on comparing a value to "now." AC-1 gains a new edge case explicitly testing that an explicit `asOf` equal to the current instant still takes the historical path.

### Medium

- **[medium]** No `ORDER BY`/deterministic sort key is specified anywhere in the ACs or Dev Notes for the access-report's user list, yet AC-4 requires stable pagination across sequential page requests. Without a defined sort order, page 2 and page 3 results are not guaranteed to be consistent or non-overlapping — especially for the historical path, which is assembled via in-memory event replay/reconstruction rather than a single ordered SQL query.

**Resolution:** D2 now specifies `userId ASC` as the deterministic sort key, applied identically to both paths. AC-4's pagination requirement is reworded to assert this explicitly, including a byte-identical-repeat-pagination assertion.

- **[medium]** No discussion of performance or cost bounds for the historical event-replay path at scale. Reconstructing state by scanning `audit_log_entries` per `(orgId, userId, projectId)` triple, for a mature org with years of audit history and many users/projects, has no stated indexing strategy, execution-time bound, or timeout/backpressure handling. AC-28's "full integration test matrix" does not include a performance test at realistic audit-log volume, despite this being flagged elsewhere in the story as "the single biggest correctness risk."

**Resolution:** D2 adds an "Indexing and performance for the historical replay path" paragraph identifying the existing `idx_audit_log_entries_org_created` index as already sufficient (no new index needed), and states an explicit execution-time expectation plus a follow-up path (materialized snapshot) if scale later requires it.

- **[medium]** D3/AC-9 describe two activity-touch calls (`touchSessionActivity` and the new `touchOrgMembershipActivity`) happening "alongside" each other in `authenticate.ts`, but never specify whether they share one try/catch (where a failure in the first could suppress the second silently) or are independently wrapped. AC-9's edge case only tests `touchOrgMembershipActivity`'s own failure in isolation, not the interaction/ordering between the two calls.

**Resolution:** D3 now explicitly requires independent, separate `try/catch` blocks for the two touch calls, each logging a distinct `warn`-level event. AC-9 gains a new edge case testing that a failure in either touch does not suppress the other; Task 1.2 updated to match.

- **[medium]** Migration-index numbering is explicitly left undetermined (D5) pending 8.1 and 8.2 landing first. With three stories all planned to add sequentially-numbered migrations, and no CI safeguard mentioned for detecting duplicate/colliding migration indices across parallel worktrees, there's a real, unaddressed delivery risk if merge order doesn't match the assumed 8.1→8.2→8.3 sequence.

**Resolution:** D5 adds a Dev Note requiring the implementer to re-read `_journal.json` as the very last step immediately before creating the migration file (not just once at story start), and calls out the need for a CI/manual collision check at merge time if two branches claim the same index.

- **[medium]** AC-27 classifies the access-report route as `sensitive-read` despite it being a `POST` endpoint that also performs a mandatory `audit_log_entries` INSERT on every successful call (AC-7). The story doesn't confirm this is the intended `route-exemptions.ts` bucket for a "read that also writes an audit row," leaving a plausible CI-classification ambiguity unresolved.

**Resolution:** AC-27 adds an explicit rationale paragraph citing the two existing `sensitive-read` precedents in `route-exemptions.ts` (`credential.value_revealed` GETs) that share this exact "read with mandatory same-transaction audit write" profile, confirming `sensitive-read` — not `mutation` or plain `read` — is correct regardless of HTTP method.

- **[medium]** Task 8.5 ("Raise the Epic 8 dedicated-UI-story gap at Epic 8 sprint planning... before marking this story `done`") embeds a cross-team scheduling/process dependency as a story completion gate. A purely organizational action (getting on a sprint-planning agenda) blocking code-complete status is an unusual coupling that risks stalling this story for reasons unrelated to its own implementation quality.

**Resolution:** Task 8.5 and the Product Surface Contract's "Linked UI story" cell are reworded: raising the Epic 8 UI story is now a tracked follow-up/reminder action, explicitly not a completion gate on this story's own `done` status.

- **[medium]** AC-21's audit payload for pseudonymization records only `targetUserId` and `tokensPseudonymized`, with no record of which other orgs share the affected `user_identity_tokens` row (per D9). If a downstream org (Org B) later needs to investigate why a user's display name changed in its own compliance records, there is no audit-log breadcrumb anywhere — not in Org B, not even in Org A's own record — documenting the cross-org blast radius of that specific pseudonymization call.

**Resolution:** AC-21's payload is extended to `{ targetUserId, tokensPseudonymized, otherAffectedOrgCount, otherAffectedOrgIds }` — the same D9 safeguard fix that resolves the two "high" findings above (5/6) also closes this gap.

- **[medium]** D12 reconciles FR71 ("Organization Admins") against epics.md's narrower "org owners" AC text by defaulting routing to `owner`-only, with per-org opt-in override to `admin`. This means any org that does not proactively reconfigure routing will, by default, **not** notify org admins of a dormant-user compliance alert at all — a narrower default behavior than FR71's PRD-level wording literally calls for. Resolving a PRD/epics wording conflict unilaterally inside a story's Dev Notes, in the direction of a narrower default, is worth flagging back to product rather than settling silently here.

**Resolution:** D12 is rewritten to default `user.dormant`'s unconfigured recipient set to the union of `owner` and `admin` roles (satisfying FR71's broader wording literally), with an explicit per-org override still available to narrow back to `owner`-only. AC-16 and Task 3.1 updated to match; the rationale for favoring the PRD-level wording over the narrower epics.md AC text is stated explicitly.

### Low

- **[low]** AC-3's "display name containing a comma and embedded quotes" edge case explicitly acknowledges in its own text that it exercises a scenario not reachable by any display name the shipped system currently produces (email-derived, or a machine-generated `user_<8chars>` alias) — describing it as exercising "a future profile-name feature." This is fine as defensive-coding documentation but overstates its status as a required regression-guarding AC for current functionality.

**Resolution:** AC-3's edge case is relabeled "Defensive-coding test, not a current-functionality regression guard," with wording explicitly stating the value is unreachable by current code paths. The test itself is unchanged (kept as cheap defensive coverage).

- **[low]** `touchOrgMembershipActivity`'s debounce map is per-process/in-memory (D3: "its own debounce map"). In a horizontally-scaled deployment with multiple API instances behind a load balancer, the debounce window is enforced only per-instance, not globally, so actual write frequency to `org_memberships.lastActiveAt` could exceed the nominal debounce interval under load-balanced traffic. This mirrors an existing characteristic of `touchSessionActivity`, but the story doesn't call out that its new sibling function inherits the same limitation.

**Resolution:** D3 adds an explicit "Known, accepted limitation — per-process debounce" paragraph documenting this inherited characteristic and why it's accepted rather than fixed here.

- **[low]** The Product Surface Contract section devotes a large, emphatic block to escalating the "no Epic 8 UI" gap as materially different from 8.1/8.2's version of the same problem, but the actual differentiator offered (epics.md's AC wording says "paginated UI table" more explicitly than 8.1/8.2's phrasing) is a fairly thin textual distinction to hang a hard epic-done gate on (Task 8.5, G2) — the substance of the gap (no Epic 8 audit/compliance UI exists yet) is identical across all three stories, and treating this story's instance as categorically different in kind (not just repetition) is arguably overstated.

**Resolution:** Resolved together with the Task 8.5 medium finding above (finding 14): the Product Surface Contract's "Linked UI story" cell is reworded to describe this as a continuation of the same accepted trade-off (not a categorically new escalation), and the hard epic-done gate language is removed in favor of a tracked follow-up action.
