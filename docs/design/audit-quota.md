# Audit-storage quota: design rationale

Why per-org audit-storage quotas work the way they do. This is a design note, not an operator
procedure — the procedures live in
[`docs/runbooks/audit-storage-exhaustion.md`](../runbooks/audit-storage-exhaustion.md) and
[`docs/runbooks/upgrade-notes.md`](../runbooks/upgrade-notes.md).

## The governing invariant

**Every degradation here is a REFUSAL of the originating operation. No degradation is ever a dropped
audit record.**

Where the codebase once silently suppressed an audit write and let the mutation commit unaudited, it
now throws `SameTransactionAuditWriteError` and the whole transaction — business row and audit row
together — rolls back. There is no "skip this write" return value anywhere in the API:
`assertOrgMayWriteAudit()` (`apps/api/src/modules/audit/quota-gate.ts`) is `Promise<void>`,
throw-or-succeed.

## The three candidate strategies

| Strategy | Verdict |
| --- | --- |
| **Sample** — write only a fraction of an over-quota org's events, drop the rest | ❌ **Rejected.** Audit completeness is 100%: zero entries dropped under any load condition, enforced as a same-transaction write invariant rather than a best-effort target. Moving audit writes out of the transaction is never a valid response — it silently voids that guarantee. A sampled log is indistinguishable from a tampered one, and an attacker who can generate volume could choose which of their own events get sampled away. No sampling mechanism exists anywhere in this codebase, not even disabled by default. |
| **Reject** — the over-quota org's audited mutating operations fail closed | ✅ **Adopted** as the hard-ceiling behaviour. |
| **Archive-and-continue** — move older entries to durable external storage, free space, keep accepting writes | ✅ **Adopted** as an operator/tenant-driven relief valve, not an automatic degradation path. Automatic purge-under-pressure is explicitly rejected: silently deleting audit history under load is tamper-adjacent and would hand a hostile org a way to erase its own trail by generating load. |

## The adopted mechanism, precisely

One enforcement mechanism, scoped to a single organization: a **storage quota**, checked and
incremented in **one atomic conditional statement** (`assertOrgMayWriteAudit()`'s gate SQL — an
`INSERT ... ON CONFLICT DO UPDATE`, both arms guarded by the same predicate) inside the same
transaction as the audit write, immediately before each of the nine `audit_log_entries` insert sites.
Zero rows returned means refused; the caller gets `503 { code: 'audit_quota_exhausted' }` via the
existing `SameTransactionAuditWriteError` → 503 branch in `secure-route.ts`.

Per-org write-**rate** limiting is a separate, independent gate (see "Rate limiting" below). The
storage quota bounds storage only.

## The three-way exemption-class split

| Class | Refused when over quota? | Accounted to | Unauthenticated-triggerable? |
| --- | --- | --- | --- |
| `SECURITY_CRITICAL_AUDIT_EVENT_TYPES` | never | `bytes_used` (may exceed quota) | no |
| `PREAUTH_ATTRIBUTABLE_EVENT_TYPES` | never | **`preauth_bytes_used`** — never an enforcement input | **yes** — this is exactly why it is separated |
| `QUOTA_REMEDIATION_EVENT_TYPES` | never | `bytes_used` | no |
| everything else | yes | `bytes_used` | no |

`PREAUTH_ATTRIBUTABLE_EVENT_TYPES` = `LOGIN_FAILED`, `ACCOUNT_RECOVERY_REQUESTED`,
`ACCOUNT_RECOVERY_LINK_SENT`, `ACCOUNT_RECOVERY_BLOCKED`. `QUOTA_REMEDIATION_EVENT_TYPES` =
`audit.quota_configured`, `audit.retention_configured`, `audit.forwarding_configured` — the exact
events an org needs to emit to get itself back under quota (lowering retention, enabling forwarding,
or having its own quota raised by an operator).

### The non-influenceability invariant

> No quantity an unauthenticated attacker can influence may appear in any refusal decision for any
> organization — directly or indirectly.

The refusal predicate is exactly `exempt(eventType) OR quota IS NULL OR bytes_used + n <= quota`. Its
four inputs: `eventType` (server-side, from the operation's outcome, never client input),
`quota_bytes` (operator-set only), `n` (the size of the entry the authenticated caller is writing),
and `bytes_used` (which accumulates only authenticated-origin volume — pre-auth volume goes to
`preauth_bytes_used`, which nothing reads for enforcement).

Two indirect channels an earlier revision had opened are closed **by deletion**, not mediation:

- **No `overheadFactor`.** The quota is denominated in **logical bytes** end to end —
  `sum(pg_column_size(t.*))`, the same quantity the incremental counter accumulates and the
  reconciliation aggregate recomputes. No conversion factor exists in the enforcement path. The
  instance-wide figure (`pg_total_relation_size`) stays in **physical bytes**: a different
  measurement of a different thing, surfaced separately in the operator-facing display.
- **No instance-wide write gate.** Nothing reads instance-wide state to decide any org's refusal.

## The instance-wide circuit breaker: deleted, not converted

`audit_storage.critical` used to gate every org's writes via `shouldSuppressAuditWrite()`. That
coupling is removed entirely — the alert itself (80/90/95% instance-wide tiering, `admin_alerts`
rows) is **unchanged**; only its consequence for the write path is gone. `shouldSuppressAuditWrite()`,
`isAuditStorageMaintenanceModeActive()`'s use as a write gate, and `logAuditWriteSuspended()` no
longer exist.

Keeping the breaker — in either its silent-drop or converted-to-hard-refusal form — produced three
defects that could not be reconciled without a fourth mechanism: a `false`-kill-switch path that still
issued a DB read, a critically-full instance with no configuration path out for either tenant or
operator, and an unauthenticated flood that could take every tenant to write-unavailable.

The residual risk the deletion left open was an instance whose orgs were all unquota'd growing until
Postgres ran out of disk. That is closed by the shipped defaults —
`AUDIT_ORG_QUOTA_ENFORCEMENT_ENABLED=true` and `AUDIT_ORG_DEFAULT_STORAGE_QUOTA_MB=2048` — which bound
every unconfigured org at a conservative instance-wide default, resolved live on every write through
the same precedence chain and the same non-influenceability invariant. This is deliberately a
*default per-org* quota, not a reinstated instance-wide gate: an org's own volume can only ever affect
its own refusal decision, a full instance still refuses only the orgs actually over their own bound,
and any org can be given an explicit, larger, or unlimited quota by an operator.

What that change deliberately did **not** do: it left write-rate limiting untouched, and it did not
reinstate any form of instance-wide write gate. The residual "instance can still fill even with every
org inside quota" overcommit risk remains exactly as described here, with the 80/90/95%
`audit_storage.warning`/`audit_storage.critical` alert as the intended signal an operator acts on —
see [`docs/runbooks/audit-storage-exhaustion.md`](../runbooks/audit-storage-exhaustion.md).

## Unit of measurement

Exactly one unit in the enforcement path: **logical bytes**, `sum(pg_column_size(t.*))` over an org's
`audit_log_entries` rows. This is what `bytes_used` accumulates toward, what the weekly
`audit-org-usage/reconcile` job recomputes, and what `quota_bytes` is expressed in.

### Write-path measurement vs. reconciliation ground truth — a disclosed deviation

`pg_column_size(t.*)` cannot be evaluated as part of the write-path gate statement: it requires a row
to already exist in the table, and the gate must decide whether to admit the write *before* the row is
inserted. Two measurements therefore exist, deliberately, and they are not the same mechanism:

- **Write-path enforcement (the hot path)** — `assertOrgMayWriteAudit()` uses
  `estimateAuditEntrySizeBytes()`: a fast, in-process JSON-length-plus-fixed-overhead estimate,
  computed in JS with no extra database round-trip. This is intentional for latency: the gate already
  runs inside the same transaction as the insert, and adding a second statement would add a round-trip
  to every audited write. The estimate is conservative and approximate **by design** — it is not, and
  is not intended to be, byte-identical to what Postgres will eventually report for the same row.
- **Reconciliation (the ground truth)** — the weekly aggregate uses the real `pg_column_size(t.*)`
  over the actual stored rows. This is the authoritative measurement: it is what `bytes_used` and
  `preauth_bytes_used` are corrected to on every run, and what any operator-facing utilization figure
  traces back to.

In short: the write path trades exactness for a zero-round-trip hot path, and periodic reconciliation
keeps that estimate honest over time. Do not read the "logical bytes, `sum(pg_column_size(t.*))`"
framing above as meaning the write-path gate calls `pg_column_size` on every write — it does not, and
this section is the disclosure of that gap.

## Schema decision: `fillfactor = 70`

`audit_org_storage_usage` is created with `fillfactor = 70` to favour HOT (heap-only-tuple) updates
and limit index churn on this row, which the gate statement rewrites on every enforced write. A
concurrency benchmark against a real migrated Postgres confirmed the intent: a ~98% HOT-update ratio
with low dead-tuple churn, and a lock-hold duration that stays flat and sub-millisecond-to-low-single-
digit-millisecond as burst volume grows.

The same benchmark showed that enabling the gates adds real, measurable latency to a *concurrent*
org's writes — two extra statements per audited write is a genuine cost under load, not an artefact.
Anyone considering enabling enforcement on a latency-sensitive deployment should re-measure on
production-like hardware rather than relying on defaults; the bench is available as
`pnpm bench:audit-quota`.

## Rate limiting: a second, independent gate

Per-org write-rate limiting is the throughput axis. It inherits every decision above unchanged and
adds one: **where** a rate window can be checked and incremented atomically.

### Why a pre-transaction placement fails

Rate limiting was originally wired into the pre-handler guard path, which runs before the handler ever
opens `db.transaction(...)`. Three independently fatal problems follow:

1. **No org RLS context is set yet.** `setRlsOrgContext(tx, auth.orgId)` runs *inside* the
   transaction. A statement issued before that point cannot safely touch an RLS-protected per-org row
   without either seeing nothing or requiring a needless `getAdminDb()` bypass call site.
2. **The exemption model needs handler-decided information the guard cannot see.** The events that
   must be exempt (`SESSION_CREATED`, `LOGIN_FAILED`, the quota-remediation events) are decided by the
   *handler's outcome*, not by which route was called. A route-granular exemption either over-exempts
   or under-exempts any route that can emit more than one event type.
3. **It reopens the storage-quota deadlock the remediation carve-out exists to close.** An org over
   both its storage quota and its rate cap would be refused on exactly the two remediation calls its
   own notification tells it to make, because a pre-handler rate gate cannot see which event type the
   handler is about to emit.

### Where the gate is placed instead

Inside the same transaction the handler already opens, immediately after `setRlsOrgContext()` and
immediately before `assertOrgMayWriteAudit()`, at each of the same nine insert sites. At that point
org RLS context is set, the caller knows the concrete `eventType` about to be written, and the
exemption classification reuses `classifyAuditWriteExemption()` unmodified.

### Colocated columns, not a new table

`rate_window_count`, `rate_window_reset_at`, `preauth_rate_window_count`,
`preauth_rate_window_reset_at`, `rate_refused_count` and `last_rate_refusal_at` are added to the
*existing* `audit_org_storage_usage` row rather than a new table. A new, unprotected rate-bucket table
would make `rate_window_count` a live, readable measure of another org's audit-write volume — exactly
what was rejected for storage. The existing row already carries RLS enforcement, already exists once
per organization, and is already touched once per audited write.

### Two statements, not one merged statement

Each gate issues its own atomic conditional statement against the same row, back to back, inside the
same transaction. The two have independent kill switches
(`AUDIT_ORG_WRITE_RATE_ENFORCEMENT_ENABLED` vs. `AUDIT_ORG_QUOTA_ENFORCEMENT_ENABLED`) and independent
effective-limit resolution; merging them would make each kill switch pay the other gate's DB cost,
breaking the zero-statement-when-off guarantee for whichever gate stays on.

### Ordering: rate gate first, then the storage gate

A request refused for throughput reasons never has its size estimated or attributed to the storage
counter — the two axes stay genuinely independent, and a rate-refused request leaves `bytes_used`
completely untouched. Do not "fix" this into the other order: an organization over both limits always
observes `429 audit_rate_limited`, never `503 audit_quota_exhausted`, for as long as it stays over its
rate cap. That is a deliberate, documented trade-off.

## Residual risks

- **Throughput is not isolated by the storage quota.** Only storage is bounded there; the rate gate is
  the separate mechanism.
- **Refusal detail is aggregate, not per-event** — `refused_write_count` / `last_refusal_at` on the
  org's own usage row (updated best-effort, on a separate connection, after the refusing transaction
  rolls back — the one place catch-and-continue is correct, because no audit record is at stake there,
  only an operational counter), plus a structured log line. These counters are erased by
  `ON DELETE CASCADE` if the org itself is deleted.
- **Aggregate allocation is bounded only by a warning**, not a refusal — see
  [`audit-log-scaling.md`](audit-log-scaling.md).
- **Reconciliation drift is one-directional** — `bytes_used` only grows between reconciliation runs
  (retention pruning and forwarding-then-prune only ever free space), so a reconciliation job that
  stops running causes orgs to be refused for storage they no longer occupy. Mitigated by the
  staleness alert and the kill switch; not solved.
- **`AUDIT_ORG_QUOTA_PHYSICAL_OVERHEAD_ESTIMATE` is a disclosed placeholder, not a measurement.** It
  defaults to `3.0`, the logical-to-physical multiplier the aggregate-allocation bound uses to compare
  the sum of per-org logical quotas against `AUDIT_LOG_STORAGE_LIMIT_GB`. No representative dataset was
  available to measure it against — a near-empty `audit_log_entries` table's ratio is dominated by
  fixed per-relation overhead, TOAST and index existence, and does not generalize. The resource-usage
  page's `observedPhysicalToLogicalRatio` diagnostic (computed fresh on every
  `GET /api/v1/admin/resource-usage`) is how an operator on a real instance can see whether the static
  estimate has drifted from reality. That value is read-only and is never fed back into the default
  automatically.
