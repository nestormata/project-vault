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

**Residual risk as it stood before Story 22.5, and what Story 22.5 actually shipped.** An instance
whose orgs were unquota'd (`quota IS NULL`, the pre-22.5 default) and whose operator ignored the
alerts could grow `audit_log_entries` until Postgres ran out of disk — there was no write-side
protection against that. The alternative (keeping the breaker, in either its silent-drop or
converted-to-hard-refusal form) produced three defects that could not be reconciled without a
fourth mechanism: a `false`-kill-switch path that still issued a DB read, a critically-full
instance with no configuration path out for either tenant or operator, and an unauthenticated flood
that could take every tenant to write-unavailable. **Story 22.5 closed this handoff** by flipping
two `env.ts` defaults together — `AUDIT_ORG_QUOTA_ENFORCEMENT_ENABLED` (`false` → `true`) and
`AUDIT_ORG_DEFAULT_STORAGE_QUOTA_MB` (`0` → `2048`, i.e. 2 GiB) — so a fresh install now bounds
every unconfigured org at a conservative instance-wide default, live-resolved on every write via
the SAME precedence chain and non-influenceability invariant documented above (no code change to
`quota-gate.ts`/`quota-config.ts` was needed or made). This is deliberately a *default per-org*
quota, not a reinstated instance-wide gate: an org's own volume can only ever affect its own
refusal decision, a full instance still refuses only the orgs that are actually over their own
bound, and any org can be given an explicit, larger, or unlimited quota by an operator via the
Story 22.3 operator surface. Two things Story 22.5 explicitly did NOT do: it left write-RATE
limiting (Story 22.2, `AUDIT_ORG_WRITE_RATE_ENFORCEMENT_ENABLED`/`AUDIT_ORG_DEFAULT_WRITE_RATE_PER_MIN`)
untouched — this is a storage-exhaustion story, not a throughput one — and it did not reinstate any
form of instance-wide write gate; the residual "instance can still fill even with every org inside
quota" overcommit risk (bounded per-org, not bounded in aggregate) remains exactly as described in
this document, with the SAME pre-existing 80/90/95% `audit_storage.warning`/`audit_storage.critical`
alert as the intended signal an operator acts on — see the new
`docs/operations/audit-storage-instance-exhaustion-runbook.md` for what to do when that alert fires
even though every org is individually within quota. Story 22.5 also added a daily early-warning
check (reusing the existing `audit-storage/check` job) that WARN-logs any already-unconfigured org
whose `bytes_used` already exceeds the new default at the moment an instance upgrades, or drifts
over it later — a pure read, never a refusal, so operators are not surprised by a live 503 with no
prior signal.

## Unit of measurement (AC-27)

Exactly one unit in the enforcement path: **logical bytes**, `sum(pg_column_size(t.*))` over an
org's `audit_log_entries` rows. This is the definition `bytes_used` accumulates toward, what
reconciliation recomputes (the weekly `audit-org-usage/reconcile` job), and what `quota_bytes` is
expressed in. No `AUDIT_ORG_QUOTA_PHYSICAL_OVERHEAD_ESTIMATE` constant is declared or read by this
story — that estimate (and the operator-facing "≈ N GB physical" display it feeds) belongs to
Story 22.3, which must measure it rather than guess it.

### Write-path measurement vs. reconciliation ground truth (disclosed deviation)

`pg_column_size(t.*)` cannot be evaluated as part of the write-path gate statement: it requires a
row to already exist in the table, and the gate must decide whether to admit the write *before* the
row is inserted (the chicken-and-egg problem Task 2a's spike named). Two measurements therefore
exist in this story, deliberately, and they are not the same mechanism:

- **Write-path enforcement (the hot path)** — `assertOrgMayWriteAudit()` (`quota-gate.ts`) uses
  `estimateAuditEntrySizeBytes()`: a fast, in-process JSON-length-plus-fixed-overhead estimate of
  the entry's size, computed in JS with no extra database round-trip. This is intentional for
  latency: the gate already runs inside the same transaction as the insert, and adding a second
  statement (e.g. inserting the row first and measuring it, or querying a comparable row's
  `pg_column_size`) would add a round-trip to every audited write. The estimate is conservative and
  approximate **by design** — it is not, and is not intended to be, byte-identical to what Postgres
  will eventually report for the same row.
- **Reconciliation (the ground truth)** — `audit-org-usage-reconcile.ts`'s weekly aggregate uses the
  real `pg_column_size(t.*)` over the actual stored rows. This is the authoritative measurement:
  it is what `bytes_used` and `preauth_bytes_used` are corrected to on every run, and it is what any
  operator-facing utilization figure is ultimately traceable to. Reconciliation periodically
  corrects any drift the write-path estimate accumulated between runs (AC-7's "usage counters are
  reconciled against ground truth periodically" — this is that mechanism, not a hypothetical one).

In short: the write path trades exactness for a zero-round-trip hot path, and periodic
reconciliation is what keeps that estimate honest over time. Do not read the "logical bytes,
`sum(pg_column_size(t.*))`" framing above as meaning the write-path gate calls `pg_column_size` on
every write — it does not, and this section is the disclosure of that gap (code review finding,
2026-08-17; product/architecture decision: disclose, do not change the write-path mechanism).

## Schema decision: `fillfactor = 70`

`audit_org_storage_usage` is created with `fillfactor = 70` (see migration
`0075_audit_org_storage_quota.sql`) to favour HOT (heap-only-tuple) updates and limit index churn
on this row, which the gate statement rewrites on every enforced write.

**(measured 2026-08-18 by Story 22.4)** — `scripts/audit-quota-isolation-bench.ts` measured the
cross-tenant coupling this fillfactor decision is meant to help bound, on real hardware against a
real, migrated Postgres, under real concurrency (independent `postgres` connections driving two
distinct, real organizations concurrently — never the shared Vitest DB). Full methodology,
threshold rationale, and edge-case handling are in the story file's Acceptance Criteria (AC-3
through AC-6); this section states the results.

**Environment fingerprint** (re-run this bench and refresh these numbers if any of this changes):

- `quota-gate.ts` commit: `cd4b872419d103b95a60079db33b6ecd46c7ee26`
- Machine: 16-core host, 62 GiB RAM, Postgres 16.10 running in a local Docker container
  (`postgres:16-alpine`), shared with several other concurrently-running worktree stacks on the
  same host at measurement time (a noisy-neighbor caveat on absolute latency, not on the
  relative-regression comparison itself, since both arms ran back-to-back on the identical
  machine state)
- Bench config: org A burst = 1200 writes/repetition x 3 repetitions at concurrency 6; org B
  concurrent steady stream up to 80 writes/repetition at concurrency 1; first 10% of each arm's
  writes discarded as warm-up

**Results:**

| Measurement | Disabled arm (today's default) | Enabled arm (both gates on) |
|---|---|---|
| Org B p50 / p95 / p99 (aggregate, warm-up discarded) | 1.89ms / 2.64ms / 5.56ms (n=61) | 2.98ms / 3.71ms / 4.54ms (n=216) |
| Org A writes completed | 3600/3600 | 3600/3600 |
| Peak shared-pool connections in use | 7 / 10 configured max | 7 / 10 configured max |
| Lock-hold proxy (gate-completes → COMMIT-completes) | p50=1.03ms p95=1.42ms max=9.01ms, flat across the burst | p50=0.76ms p95=0.99ms max=4.97ms, flat across the burst |
| `pg_stat_user_tables` delta on `audit_org_storage_usage` | +0 dead tuples, +0 updates (gate never touches the row when off) | +848 dead tuples, +7266 updates, 7134 HOT (**98.2% HOT-update ratio**) |

**Org B p95 regression (enabled vs. disabled, same run, same machine): 40.7% — FAILS the ≤25%
threshold (AC-3).** Per-repetition regressions: +45.0%, +50.5%, -17.7% (high variance between
repetitions — see "Finding" below). Raw JSON artifact:
`scripts/.bench-output/audit-quota-bench-2026-08-18T12-49-18-130Z.json` (not committed; regenerate
by re-running `pnpm bench:audit-quota`).

**Finding — regression exceeds the AC-3 threshold.** The gate adds two extra statements
(rate-window check + storage-quota check) to every audited write before its `INSERT`, all
contending for row-level locks on the same `audit_org_storage_usage` row org A's burst is hammering
concurrently. The `fillfactor = 70` schema decision IS achieving its intended effect at the storage
layer (98.2% HOT-update ratio — dead-tuple churn is low and index bloat is being avoided), and the
lock-hold proxy duration itself stays flat and sub-millisecond-to-low-single-digit-millisecond
under load (no evidence of lock-hold time growing with burst volume) — so the regression is not
explained by lock queueing growing unboundedly. The most likely explanation is the straightforward
one: two additional round trips per write is real, measurable added latency under load, and org A's
concurrent burst (6 simultaneous writers) is enough to make that added cost visible in org B's
tail latency. The per-repetition variance (+45%, +50%, -17.7%) also suggests this host's shared
Postgres container (contending with several sibling worktree stacks at measurement time — see
environment fingerprint above) contributes real machine-noise variance on top of the gate's own
cost; a quieter dedicated machine would likely narrow — but is not expected to eliminate — this
regression.

**Candidate next steps** (not implemented by this story — a human decision, per Task 6):
1. Re-run this bench on a quiet, dedicated (non-shared) machine to separate the gate's true added
   cost from this run's host contention, before deciding whether to act on the number.
2. If the regression holds on a quiet machine, consider whether the rate gate and storage gate
   could be combined into a single round trip (they currently run as two sequential statements in
   the same transaction) — this is a `quota-gate.ts` design change, out of this story's scope.
3. Do not enable `AUDIT_ORG_QUOTA_ENFORCEMENT_ENABLED` / `AUDIT_ORG_WRITE_RATE_ENFORCEMENT_ENABLED`
   in production based on this result without re-validating on production-like hardware first —
   this bench's absolute numbers are local-Docker numbers, not production numbers; only the
   relative-regression finding (not the absolute millisecond figures) should inform that decision.

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
- **D-9 (new, code review finding, 2026-08-17): this note previously implied `pg_column_size` was
  the measurement used everywhere, including the write-path gate.** It is not — the write-path gate
  uses the fast in-process estimate `estimateAuditEntrySizeBytes()`, not `pg_column_size`, for
  latency reasons. Product/architecture decision: disclose the deviation rather than add a
  `pg_column_size` round-trip to the hot write path. See "Write-path measurement vs. reconciliation
  ground truth" above.

## Cross-reference

See `docs/operations/audit-log-scaling.md` for the escalation path (table partitioning) this
story's residual risks eventually lead to, and for the AC-12 release-note entry describing the
instance-wide breaker's deletion.

## Addendum: per-org write-rate limiting (Story 22.2)

This addendum records Story 22.2's own design decision — the throughput axis, a second and
independent gate from the storage-quota mechanism documented above. It inherits every decision
above unchanged (D1, the deleted instance-wide circuit breaker, the three exemption classes) and
adds exactly one new decision: WHERE and HOW a rate window can be checked and incremented
atomically without repeating the mistake below.

### Why the previous (pre-transaction) placement failed

Rate limiting was originally Layer 1 of this story's first two drafts, wired into
`enforceProtectedGuards()` — which runs and gates the request BEFORE `runProtectedHandler()` ever
opens `db.transaction(...)`. Three independently fatal problems followed:

1. **No org RLS context is set yet.** `setRlsOrgContext(tx, auth.orgId)` runs *inside* the
   transaction, immediately after it opens. A statement issued before that point cannot safely
   touch an RLS-protected per-org row without either seeing nothing or requiring a needless new
   `getAdminDb()` bypass call site.
2. **The exemption model needs handler-decided information the guard cannot see.** The events that
   must be exempt from rate refusal (`SESSION_CREATED`, `LOGIN_FAILED`, the quota-remediation
   events) are decided by the *handler's outcome*, not by which route was called. A route-granular
   exemption either over-exempts or under-exempts a route that can emit more than one event type.
3. **It reopens the storage-quota deadlock Story 22.1's remediation carve-out exists to close.** An
   organization over both its storage quota and its rate cap would be refused on exactly the two
   remediation calls its own notification tells it to make, with no way to escape either limiter,
   because a pre-handler rate gate cannot see which event type the handler is about to emit.

### Where the gate is placed instead

Inside the same `db.transaction(...)` `runProtectedHandler()` already opens, immediately after
`setRlsOrgContext()` runs and immediately before (in the same code path as, not merged into) Story
22.1's `assertOrgMayWriteAudit()` call, at each of the same nine insert sites. At that point org
RLS context is set (closes problem 1), the caller already knows the concrete `eventType` about to
be written — it is the same input already passed to `assertOrgMayWriteAudit()` (closes problem 2)
— and the exemption classification is the exact same three-way split Story 22.1 already built,
reused without modification via `classifyAuditWriteExemption()` (closes problem 3).

### Colocated columns, not a new table

`rate_window_count`, `rate_window_reset_at`, `preauth_rate_window_count`,
`preauth_rate_window_reset_at`, `rate_refused_count`, and `last_rate_refusal_at` are added to the
*existing* `audit_org_storage_usage` row (migration `0077_audit_org_write_rate_limit.sql`) rather
than a new table. A new, unprotected rate-bucket table would make `rate_window_count` a live,
readable measure of another org's audit-write volume — exactly what finding H6 rejected for
storage. The existing row already carries RLS enforcement (`audit_org_storage_usage_isolation`,
`FOR ALL ... USING ... WITH CHECK`, `FORCE ROW LEVEL SECURITY`), already exists once per
organization, and is already touched once per audited write by the quota gate — adding rate
columns costs zero new RLS surface and zero new `EXCLUDED_TABLES` justification.

### Two statements, not one merged statement

The rate gate and the storage gate each issue their own atomic conditional statement against the
same row, back to back, inside the same already-open transaction — not merged into a single SQL
statement. The two gates have independent kill switches
(`AUDIT_ORG_WRITE_RATE_ENFORCEMENT_ENABLED` vs. `AUDIT_ORG_QUOTA_ENFORCEMENT_ENABLED`) and
independent effective-limit resolution; merging them would make each kill switch pay the other
gate's DB cost, breaking the zero-statement-when-off guarantee for whichever gate stays on.

### Ordering: rate gate runs first, then the storage gate

Both gates run after `setRlsOrgContext()` and before the insert, with the rate gate always
evaluated first. A request refused for throughput reasons never has its size estimated or
attributed to the storage counter — the two axes stay genuinely independent, and a rate-refused
request leaves `bytes_used` completely untouched. Do not "fix" this into the other order: an
organization over both limits always observes `429 audit_rate_limited`, never
`503 audit_quota_exhausted`, for as long as it stays over its rate cap — a deliberate,
documented trade-off (see Story 22.2's Open Question 4), not a bug.

### Exemption-class reuse (no new exemption logic)

`classifyAuditWriteExemption(eventType)` is called once per write and its result is used by BOTH
gates:

| Class | Refused when over rate cap? | Counted toward the ENFORCED rate counter? |
|---|---|---|
| `security_critical` | never | yes (may exceed the cap) |
| `preauth` | never | no — counted to a separate, non-enforced column |
| `remediation` | never | yes (may exceed the cap; the remediation write itself is never refused) |
| everything else | yes | yes |

This is the same reasoning as Story 22.1's own non-influenceability invariant: an unauthenticated
attacker who can generate `LOGIN_FAILED` volume must not be able to drive any organization's rate
counter past its cap. Routing pre-auth-attributable volume to a separate, unenforced counter closes
that channel for rate exactly as `preauth_bytes_used` closed it for storage.

## Physical-overhead estimate (Story 22.3)

Story 22.1's AC-27 assigned this obligation to Story 22.3: declare, measure (or honestly disclose
an unmeasured default for), and document `AUDIT_ORG_QUOTA_PHYSICAL_OVERHEAD_ESTIMATE` — the
logical-to-physical multiplier the resource-usage page's aggregate-allocation (overcommit) bound
uses to convert Σ per-org `quota_bytes` (logical, row-data-only) into an estimated physical-bytes
figure comparable against `AUDIT_LOG_STORAGE_LIMIT_GB`.

**Measurement spike attempted, no representative dataset available.** This story's implementation
session ran the measurement query —

```sql
SELECT pg_total_relation_size('audit_log_entries')::float8 /
       NULLIF(SUM(pg_column_size(t.*)), 0) AS ratio
FROM audit_log_entries t
```

— against this worktree's own development database. That database had **zero** rows in
`audit_log_entries` visible to the query's connection at the time of measurement (a fresh
per-worktree Postgres instance, RLS-scoped, with no seeded production-like volume) — a result that
is not just unrepresentative but computes to `NULL` (division by zero, guarded by `NULLIF`), so no
usable ratio could be derived from it. No other realistic-volume database (staging or production)
was reachable from this implementation environment.

**Accepted fallback, per AC-8's own documented escape hatch:**
`AUDIT_ORG_QUOTA_PHYSICAL_OVERHEAD_ESTIMATE` defaults to **`3.0`** —
`apps/api/src/config/env.ts`'s own comment on this var states this plainly. `3.0` is **not** a
measurement; it is Story 22.1's AC-27 illustrative figure ("an operator wanting to give an org
~3 GB of real disk sets a 1 GB logical quota"), reused here as an honestly-disclosed placeholder
rather than a silently-guessed number. This satisfies AC-8's actual requirement (a
measure-or-disclose *process*, not a specific output value) but does **not** satisfy the spirit of
having a real measurement backing the enforced bound.

**Tracked follow-up (Open Question, this story's Dev Notes):** re-run the measurement query above
against a production or production-like staging database with a realistic volume of rows (hundreds
to thousands, spanning varied event types and payload sizes — a near-empty table's ratio is
dominated by fixed per-relation overhead, TOAST, and index-existence and will not generalize), and
update `AUDIT_ORG_QUOTA_PHYSICAL_OVERHEAD_ESTIMATE`'s default in `apps/api/src/config/env.ts`
accordingly. Until that re-measurement happens, the resource-usage page's `observedPhysicalToLogicalRatio`
diagnostic (AC-1/AC-7 — `auditLogStorage.currentBytes ÷ Σ auditStorageByOrg[].bytesUsed`, computed
fresh on every `GET /admin/resource-usage`) is the mechanism by which a maintainer or operator on a
real instance can see whether the static `3.0` estimate has drifted from reality and knows to
re-run this measurement — see AC-7's Pre-mortem finding for the full rationale. This diagnostic
value is read-only and is never fed back into the env default automatically.
