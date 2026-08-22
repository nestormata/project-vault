# Audit-storage instance-exhaustion runbook

Story 22.5. Two scenarios, both operational, neither a code change: (1) preparing for the upgrade
that ships Story 22.5's new defaults, and (2) responding to the existing instance-wide
`audit_storage.critical`/`audit_storage.warning` alert (Story 9.2, unchanged) firing even though
every individual org is inside its own quota. See
`docs/operations/audit-quota-degradation-strategy.md`'s "The instance-wide circuit breaker: deleted,
not converted" section for the design rationale behind why this project alerts-plus-runbooks this
scenario rather than reinstating an instance-wide write gate — this doc does not duplicate that
rationale, only the operational SQL/actions.

## Section 1 — Upgrading to this version (read before you upgrade, not after)

**What changed.** Two `apps/api/src/config/env.ts` defaults flipped together:

| Variable | Old default | New default |
|---|---|---|
| `AUDIT_ORG_QUOTA_ENFORCEMENT_ENABLED` | `false` | `true` |
| `AUDIT_ORG_DEFAULT_STORAGE_QUOTA_MB` | `0` (unlimited) | `2048` (2 GiB) |

**Why.** Before this story, an organization with no explicit `audit_storage_quota_config` row was
fully unbounded — the master kill switch defaulted off, and even if it were on, the fallback quota
was `0` ("unlimited"). This story closes that gap: on a fresh install (or any upgrading instance
that has never touched these two variables), every unconfigured org is now bounded at a
conservative 2 GiB logical default. See `docs/operations/audit-quota-degradation-strategy.md` for
the full non-influenceability and sizing rationale.

**How to opt out entirely before upgrading.** Set in your own `.env`:

```
AUDIT_ORG_QUOTA_ENFORCEMENT_ENABLED=false
```

This gets you exactly the pre-22.5 shipped behavior, unconditionally — the kill switch is checked
first, in process memory, before any database access.

**How to raise the default for all unconfigured orgs at once.** Set in your own `.env`:

```
AUDIT_ORG_DEFAULT_STORAGE_QUOTA_MB=<value in MB>
```

`0` remains a valid, still-honored value meaning "no instance-wide fallback" (equivalent to the
pre-22.5 default) if you explicitly set it yourself.

**How to check NOW, before upgrading, whether any existing org would immediately exceed the new
2 GiB default.** Run directly against your database (adjust the threshold if you plan to set a
different `AUDIT_ORG_DEFAULT_STORAGE_QUOTA_MB`):

```sql
SELECT usage.org_id, usage.bytes_used
FROM audit_org_storage_usage usage
LEFT JOIN audit_storage_quota_config cfg ON cfg.org_id = usage.org_id
WHERE cfg.org_id IS NULL          -- no explicit per-org quota row (NOT the same as an explicit NULL
                                   -- quota row, which means an operator's deliberate "unlimited"
                                   -- override and is correctly excluded here)
  AND usage.bytes_used > 2147483648  -- 2048 MB * 1048576, in bytes
ORDER BY usage.bytes_used DESC;
```

For each org this returns, before upgrading you can either:

- Raise that org's explicit quota via the Story 22.3 operator surface (`PUT
  /admin/orgs/:orgId/audit-quota`, or the equivalent web page), so it never resolves to the
  instance default at all, or
- Set a higher `AUDIT_ORG_DEFAULT_STORAGE_QUOTA_MB` in your `.env` before deploying the new
  version, so the instance-wide fallback itself covers this org's current usage.

**If you don't run the query above before upgrading.** The daily `audit-storage/check` job
(already cron-scheduled, `main.ts`'s `'0 4 * * *'`) now includes an early-warning step: within 24
hours of upgrading, any org already over the new default is WARN-logged
(`OperationalEvent.AUDIT_ORG_DEFAULT_QUOTA_ALREADY_EXCEEDED`) naming the org id, its current
`bytes_used`, and the resolved default quota. This is a pure read — never a refusal — but it is a
same-day, after-the-fact signal rather than a before-you-upgrade one; running the SQL above first is
strictly more reliable.

**`.env.example` diff (human-actionable — apply manually; this repo's tooling cannot edit this
file directly).** Update these two lines to reflect the new shipped defaults:

```diff
- AUDIT_ORG_QUOTA_ENFORCEMENT_ENABLED=false
+ AUDIT_ORG_QUOTA_ENFORCEMENT_ENABLED=true

- AUDIT_ORG_DEFAULT_STORAGE_QUOTA_MB=0
+ AUDIT_ORG_DEFAULT_STORAGE_QUOTA_MB=2048
```

(Exact current line text/formatting in `.env.example` may differ slightly — match the surrounding
comment style already present for these two variables.)

## Section 2 — `audit_storage.critical` fired, but every org is inside its own quota

This is expected and by design, not a bug: per-org quotas (default or explicit) bound each org's
OWN contribution to `audit_log_entries`, but nothing bounds the SUM across every org on the
instance. An instance can be overcommitted — many orgs each comfortably within their own quota,
whose quotas nonetheless add up to more disk than the instance actually has. The existing
`audit_storage.critical`/`.warning` alert (80/90/95% tiered, `apps/api/src/workers/audit-storage-check.ts`,
unchanged since Story 9.2) is the correct and ONLY backstop for this — alerting plus this runbook,
never a second write gate (see the design doc's "deleted, not converted" section for why an
instance-wide write gate is deliberately not reintroduced).

### Step 1 — Identify the largest contributors

The alert payload itself already includes this (`computeTopContributingOrgs()`, Story 9.4
AC-16/AC-17) — check the `admin_alerts` row's `payload.topContributingOrgs` field, or query
directly:

```sql
SELECT org_id, count(*) AS rows_added
FROM audit_log_entries
WHERE created_at > now() - interval '24 hours'
GROUP BY org_id
ORDER BY count(*) DESC
LIMIT 5;
```

### Step 2 — Lower the instance-wide default (fastest, affects every unconfigured org)

If most of the pressure comes from many small-to-medium unconfigured orgs rather than one or two
large ones, lowering the instance-wide default is the fastest lever:

```
AUDIT_ORG_DEFAULT_STORAGE_QUOTA_MB=<lower value in MB>
```

This takes effect immediately on the next resolution (no restart-then-migrate step — the
precedence chain reads `env.*` live on every write, no cache, no backfill).

### Step 3 — Tighten individual large orgs' EXPLICIT quotas

For orgs identified in Step 1 that already have (or should have) an explicit quota row, lower it
via the Story 22.3 operator surface (`PUT /admin/orgs/:orgId/audit-quota`, or the equivalent web
page). The write-time overcommit check on that endpoint
(`computeAuditQuotaAllocation()`) will warn if the resulting aggregate is still over the
instance-wide 80% threshold, so this step also self-checks whether it was enough.

### Step 4 — Point large contributors at retention/forwarding, which they can always use

Retention configuration (`audit_retention_config.retention_days`) and forwarding-then-prune are
both members of `QUOTA_REMEDIATION_EVENT_TYPES` — an org can always reconfigure its own retention
or enable forwarding even while it is itself over quota (this is the deadlock-prevention property
Story 22.1 built in). Pointing a large contributor at shorter retention or S3/webhook forwarding
frees space without waiting on an operator-side quota change.

### Step 5 — When the honest answer is "provision more disk"

If every org is legitimately using its allotted quota (not a misconfiguration, not a runaway
writer) and the SUM genuinely exceeds available disk, no configuration change fixes this — the
instance needs more storage. Steps 2–4 above buy time; they do not substitute for capacity planning
once real, sustained multi-org audit volume outgrows the disk an instance was provisioned with.

## Cross-references

- `docs/operations/audit-quota-degradation-strategy.md` — the full design rationale (why a default
  per-org quota, not an instance-wide gate; the non-influenceability invariant; the SQL precision
  trap between "no quota-config row" and "an explicit NULL quota row").
- `docs/operations/audit-log-scaling.md` — the broader escalation-path table this runbook's
  Section 2 slots into.
- `_bmad-output/implementation-artifacts/22-3-per-org-audit-storage-operator-surface.md` (Story
  22.3) — the operator API/web surface referenced in Sections 1 and 2.
