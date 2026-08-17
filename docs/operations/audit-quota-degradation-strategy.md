# Audit-storage quota degradation strategy (Story 22.1)

> Design decision, ratified as required by Task 1 of Story
> `22-1-per-org-audit-storage-quota-and-rate-limiting`. This note and the story's Design Decision
> D1 section must not contradict each other — any enforcement behaviour in the shipped code should
> trace back to a paragraph here.

## The governing invariant

**Every degradation in this story is a REFUSAL of the originating operation. No degradation is
ever a dropped audit record.**

Where the pre-story codebase silently suppressed an audit write and let the mutation commit
unaudited (`shouldSuppressAuditWrite()` / `isAuditStorageMaintenanceModeActive()` in
`apps/api/src/modules/audit/maintenance-mode.ts`), it now throws
`SameTransactionAuditWriteError` and the whole transaction — business row and audit row together —
rolls back. There is no "skip this write" return value anywhere in the new API
(`assertOrgMayWriteAudit()` in `apps/api/src/modules/audit/quota-gate.ts` is `Promise<void>`,
throw-or-succeed).

## The three candidate strategies

| Strategy | Verdict |
|---|---|
| **Sample** (write only a fraction of an over-quota org's events, drop the rest) | ❌ **Rejected.** `_bmad-output/planning-artifacts/architecture.md:58` — *"Audit completeness: 100% — zero entries dropped under any load condition; enforced as a same-transaction write invariant, not a best-effort target."* `architecture.md:82` — *"Moving audit writes out of the transaction is never a valid response — it silently voids the audit completeness guarantee."* A sampled log is indistinguishable from a tampered one, and an attacker who can generate volume could choose which of their own events get sampled away. No sampling mechanism exists anywhere in this codebase, not even disabled by default. |
| **Reject** (the over-quota org's audited mutating operations fail closed) | ✅ **Adopted** as the hard-ceiling behaviour. |
| **Archive-and-continue** (move older entries to durable external storage, free space, keep accepting writes) | ✅ **Adopted** as an operator/tenant-driven relief valve, not an automatic degradation path. Automatic purge-under-pressure is explicitly rejected — silently deleting audit history under load is tamper-adjacent and would hand a hostile org a way to erase its own trail by generating load. |

## The adopted mechanism, precisely

One enforcement mechanism, scoped to a single organization: a **storage quota**, checked and
incremented in **one atomic conditional statement** (`assertOrgMayWriteAudit()`'s gate SQL — an
`INSERT ... ON CONFLICT DO UPDATE`, both arms guarded by the same predicate) inside the same
transaction as the audit write, immediately before each of the (now nine, see *Documentation
drift* below) `audit_log_entries` insert sites. Zero rows returned means refused; the caller gets
`503 { code: 'audit_quota_exhausted' }` via the existing `SameTransactionAuditWriteError` → 503
branch in `secure-route.ts`.

Per-org write-**rate** limiting (the "Layer 1" of earlier drafts of this story) was removed in the
story's own second-pass revision, before this implementation began, and is deferred to Story 22.2.
This story bounds storage only.

## The three-way exemption-class split (AC-11/AC-28/AC-29)

| Class | Refused when over quota? | Accounted to | Unauthenticated-triggerable? |
|---|---|---|---|
| `SECURITY_CRITICAL_AUDIT_EVENT_TYPES` (`maintenance-mode.ts`, unchanged membership) | never | `bytes_used` (may exceed quota) | no |
| `PREAUTH_ATTRIBUTABLE_EVENT_TYPES` (`quota-gate.ts`, new) | never | **`preauth_bytes_used`** — never an enforcement input | **yes** — this is exactly why it is separated |
| `QUOTA_REMEDIATION_EVENT_TYPES` (`quota-gate.ts`, new) | never | `bytes_used` | no |
| everything else | yes | `bytes_used` | no |

`PREAUTH_ATTRIBUTABLE_EVENT_TYPES` = `LOGIN_FAILED`, `ACCOUNT_RECOVERY_REQUESTED`,
`ACCOUNT_RECOVERY_LINK_SENT`, `ACCOUNT_RECOVERY_BLOCKED`. `QUOTA_REMEDIATION_EVENT_TYPES` =
`audit.quota_configured`, `audit.retention_configured`, `audit.forwarding_configured` — the exact
events an org needs to be able to emit to get itself back under quota (lowering retention,
enabling forwarding, or having its own quota raised by an operator).

### The non-influenceability invariant (checkable form)

> No quantity an unauthenticated attacker can influence may appear in any refusal decision for any
> organization — directly or indirectly.

The refusal predicate is exactly `exempt(eventType) OR quota IS NULL OR bytes_used + n <= quota`.
Its four inputs: `eventType` (server-side, from the operation's outcome, never client input),
`quota_bytes` (operator-set only), `n` (the size of the entry the authenticated caller is writing),
`bytes_used` (accumulates only authenticated-origin volume — pre-auth volume goes to
`preauth_bytes_used` instead, which nothing reads for enforcement). Two indirect channels a prior
revision of this story had opened are both closed **by deletion**, not mediation:

- **No `overheadFactor`.** The quota is denominated in **logical bytes** end to end —
  `sum(pg_column_size(t.*))`, the same quantity the incremental counter accumulates and the
  reconciliation aggregate recomputes (AC-27). No conversion factor exists in the enforcement
  path. The instance-wide figure (`pg_total_relation_size`) stays in **physical bytes** and is a
  different measurement of a different thing — the operator-facing display that says so ships in
  Story 22.3.
- **No instance-wide write gate.** `isAuditStorageMaintenanceModeActive()`'s use as a write gate is
  deleted (see below). Nothing reads instance-wide state to decide any org's refusal.

## The instance-wide circuit breaker: deleted, not converted

`audit_storage.critical` (`apps/api/src/workers/audit-storage-check.ts`) used to gate every org's
writes via `shouldSuppressAuditWrite()`. That coupling is removed entirely — the alert itself
(80/90/95% instance-wide tiering, `admin_alerts` rows) is **unchanged**; only its consequence for
the write path is gone. `shouldSuppressAuditWrite()`, `isAuditStorageMaintenanceModeActive()`'s use
as a write gate, and `logAuditWriteSuspended()` no longer exist.

**Residual risk, accepted and stated:** an instance whose orgs are unquota'd (`quota IS NULL`, the
default) and whose operator ignores the alerts can grow `audit_log_entries` until Postgres runs out
of disk — there is no write-side protection against that after this story. This is a worse
*failure* than a refusal, but the alternative (keeping the breaker, in either its silent-drop or
converted-to-hard-refusal form) produced three defects that could not be reconciled without a
fourth mechanism: a `false`-kill-switch path that still issued a DB read, a critically-full
instance with no configuration path out for either tenant or operator, and an unauthenticated flood
that could take every tenant to write-unavailable. **This is a tracked handoff, not an accepted
permanent gap: Story 22.5 owns it**, and is expected to re-establish instance-level protection via
a *default* per-org quota (bounding the unconfigured org) rather than reinstating an instance-wide
gate.

## Unit of measurement (AC-27)

Exactly one unit in the enforcement path: **logical bytes**, `sum(pg_column_size(t.*))` over an
org's `audit_log_entries` rows. This is what `bytes_used` accumulates (the gate statement), what
reconciliation recomputes (the weekly `audit-org-usage/reconcile` job), and what `quota_bytes` is
expressed in. No `AUDIT_ORG_QUOTA_PHYSICAL_OVERHEAD_ESTIMATE` constant is declared or read by this
story — that estimate (and the operator-facing "≈ N GB physical" display it feeds) belongs to
Story 22.3, which must measure it rather than guess it.

## Schema decision: `fillfactor = 70`

`audit_org_storage_usage` is created with `fillfactor = 70` (see migration
`0075_audit_org_storage_quota.sql`) to favour HOT (heap-only-tuple) updates and limit index churn
on this row, which the gate statement rewrites on every enforced write. **The cross-tenant coupling
this is meant to help bound — pool contention, dead-tuple churn, autovacuum load on the shared
cluster — is measured by Story 22.4, not by this story.** 22.1 states it as an open, unmeasured
risk; it does not claim it is bounded.

## Residual risks summary

- **Throughput is not isolated.** Only storage is bounded here; write-rate limiting is Story 22.2.
- **Refusal detail is aggregate, not per-event** — `refused_write_count` / `last_refusal_at` on the
  org's own usage row (updated best-effort, on a separate connection, after the refusing
  transaction rolls back — the one place in this story catch-and-continue is correct, because no
  audit record is at stake there, only an operational counter), plus a structured log line. These
  counters are erased by `ON DELETE CASCADE` if the org itself is deleted.
- **Aggregate allocation is not bounded against instance capacity** in this story — the Σ`quota_bytes` vs. instance-capacity check is Story 22.3's, once an operator-facing quota-setting endpoint exists.
- **Reconciliation drift is one-directional** — `bytes_used` only grows between reconciliation
  runs (retention pruning and forwarding-then-prune only ever free space), so a reconciliation job
  that stops running causes orgs to be refused for storage they no longer occupy. Mitigated by the
  staleness alert and the AC-25 kill switch; not solved here (Open Question 8).

## Documentation drift found while implementing (re-verified 2026-08-17)

Task 1 requires re-verifying this story's own citations before trusting them. Implementation-time
findings, beyond what the story file's own revision history already recorded:

- **D-6 (new): Story 24.1 and 24.2 have already shipped in this codebase** (migrations
  `0070_rls_ownership_and_force.sql`, `0071_admin_pool_role.sql`), contrary to the story's Dev
  Notes ("Tenancy enforcement reality check"), which assumed neither had landed. RLS with `FORCE
  ROW LEVEL SECURITY` is a real boundary for the `vault_app` role today, and `getAdminDb()` is
  backed by a non-superuser, explicitly-grant-scoped `vault_admin` role — not a superuser. Both new
  tables in this story are owned by `vault_owner`, have `FORCE ROW LEVEL SECURITY`, and a real
  `FOR ALL ... USING ... WITH CHECK` policy, consistent with every other table added since 0070.
- **D-7 (new): there are NINE `audit_log_entries` insert sites, not eight.** Story 23.3
  (`apps/api/src/lib/capability-gate-audit.ts`, `capability.denied` events) landed after this story
  was drafted and added a ninth site with no suppression/gate check of its own. It is now gated
  (`scripts/check-audit-insert-sites.ts`'s allowlist has nine entries) and its own doc comment
  explains why a refusal there never turns a completed 403 into a 503.
- **D-8 (new): `docs/operations/audit-log-scaling.md` did not exist.** `architecture.md` and this
  story both assume it does, as the escalation-path doc AC-1 must cross-link. Created alongside
  this note (see that file for the cross-link and the AC-12 release-note entry).

## Cross-reference

See `docs/operations/audit-log-scaling.md` for the escalation path (table partitioning) this
story's residual risks eventually lead to, and for the AC-12 release-note entry describing the
instance-wide breaker's deletion.
