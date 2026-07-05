# Story 8.2: Audit Log Search, Export & External Forwarding

Status: ready-for-dev

<!-- Ultimate context engine analysis completed 2026-07-04 — comprehensive developer guide for audit log search/filter, mandatory-integrity-verified CSV export, webhook/S3 external forwarding, and retention pruning. This story builds ON TOP of Story 8.1's `audit_log_entries` table, HMAC write path, and `verifyAuditRange()` — it does not touch the write path itself. Read "Key Design Decisions & Open Questions" before writing any code: two of the decisions below (D2 retention-vs-append-only-trigger conflict, D3 forwarding delivery mechanism) resolve genuine conflicts between epics.md's literal wording and infrastructure Story 8.1 already ships. Skipping them will produce code that cannot pass CI or, worse, code that silently violates the append-only guarantee Story 8.1 just built. -->

## Story

As a compliance officer conducting an audit,
I want to search, filter, and export audit log data with mandatory integrity verification, and forward logs to external write-once storage,
so that I can produce a verifiable compliance record that travels with integrity proof.

*Covers: FR41, FR42, FR43, FR70.* [Source: `_bmad-output/planning-artifacts/epics.md#Story-8.2` (lines 1902-1929)]

**Out of scope for this story (belongs to other stories — do not implement here):**
- The `audit_log_entries` table, HMAC write path, append-only RLS/trigger/grant stack, and `GET /api/v1/org/audit/verify` — **Story 8.1** (`ready-for-dev`, see Prerequisites below — **this story cannot be implemented until 8.1 is `done`**, not merely `ready-for-dev`).
- Point-in-time access reports, dormant-user detection, user pseudonymization endpoint — **Story 8.3** (FR44, FR69, FR71, FR102).
- Data-subject erasure request handling — **Story 8.4**.
- The separate `platform_audit_events` table and its own operator-only verify/search/export surface — **Story 9.4**. Do not extend this story's search/export/forwarding to the platform-audit table; it is structurally separate (see 8.1's cross-story context row for 9.4).
- Per-tier enforcement of retention-day limits ("within the limits set by their subscription tier" — FR70's literal wording). **No subscription-tier or instance-policy concept exists anywhere in this codebase today** (confirmed by grep across `packages/db/src/schema/`, `apps/api/src/modules/` — zero hits for "tier", "subscription", or "instancePolicy"). The closest planned concept is Story 9.2's `instancePolicy: { maxOrgs, maxUsersPerOrg, ... }` (`epics.md:2035-2063`, `backlog`), which does not mention audit retention limits either. This story implements `retentionDays` configuration with a platform-wide sane bound (`AUDIT_RETENTION_MIN_DAYS`/`AUDIT_RETENTION_MAX_DAYS`, see D6) and **does not** enforce a per-org tier ceiling — there is no tier data to check against. **Story 9.2 (or whichever future story introduces tiers/instance policy) must revisit `PUT /audit/retention`'s validation to add a tier-ceiling check once tier data exists.** Flag this explicitly in that future story's planning rather than rediscovering it as a bug.
- Alerting on stale/never-delivered webhook forwarding (e.g., an `audit.forwarding_stalled` notification via the FR100 alert-routing system). This story auto-disables a webhook destination after repeated failures (see AC-19) and logs the condition, but does not wire a user-facing alert — that would require the notification-routing infrastructure (Epic 3) to gain a new `alertType`, which is a reasonable follow-up but is not required by epics.md's literal AC-E8b/FR43 text.

**Threat model note (carried forward from Story 8.1, applies equally here):** this story's search/export surface reveals audit metadata (actor, event type, IP address, timestamps) but never credential plaintext — `payload` JSONB on `audit_log_entries` is populated exclusively by write-path code that already excludes secret values (Story 8.1 D1, `FORBIDDEN_AUDIT_KEYS` in `secure-route.ts`). This story's CSV export and webhook/S3 forwarding therefore carry the same exposure profile as the underlying table — compliance-sensitive metadata, not credential material. External forwarding destinations (attacker-influenced webhook URLs, operator-controlled S3 buckets) are a genuinely new outbound-network surface this story introduces; see D4 (SSRF protections) for why this matters and what is implemented.

---

## Product Surface Contract

> Required. Rules: `_bmad-output/implementation-artifacts/product-surface-contract.md`

| Field | Value |
|-------|-------|
| **Surface scope** | `api` |
| **Evaluator-visible** | no — this story ships REST endpoints (search, export, forwarding config, retention config) consumed via API/curl or a future admin UI, not a web screen |
| **Linked UI story** (if API-only) | `TBD` — **same accepted gap Story 8.1 flagged, not a new one, not a blocker to `ready-for-dev`:** no story in the current `epics.md` (Epic 8's four stories, or any other epic) scopes a dedicated web UI for audit search/export/forwarding configuration, despite the UX spec's Dana persona explicitly wanting "filterable, exportable audit logs" (`ux-design-specification.md:83`) and epics.md's own AC-E8c implying a UI table ("displayed in the UI as a paginated table"). Story 8.1 already raised this gap at the Epic 8 preamble level; it has not been resolved by a new story number as of this story's creation. **This story proceeds API-only deliberately, continuing 8.1's precedent** — the gap must be raised again at Epic 8 sprint planning/retrospective before Epic 8 can reach `done` (Product Surface Contract G2), not silently re-discovered. |
| **Honest placeholder AC** (if UI deferred) | N/A — no UI is being deferred with a placeholder; none exists yet for this surface, and no SvelteKit route should be stubbed in this story (dead route with no linked follow-up story). |
| **Persona journey** | N/A — API-only, no evaluator-visible UI in this story. Rationale: FR41/FR42/FR43/FR70 describe search/export/forwarding *capabilities* consumed by a compliance officer via API/export tooling or a future UI; there is no human end-user journey through a web surface for this story's scope. |

---

## Key Design Decisions & Open Questions

**Read this section before writing any code.** Two of these (D2, D3) resolve genuine conflicts between epics.md's literal wording and infrastructure Story 8.1 already ships or this story must newly introduce. Getting D2 wrong means retention pruning silently fails in production (blocked by 8.1's own append-only trigger + grant revoke); getting D3 wrong means either every audit-writing code path in the app needs modification, or webhook delivery is unreliable.

### D1 — Reuse Story 8.1's primitives; extend its files, don't duplicate them

- `apps/api/src/modules/audit/verify.ts` exports `verifyAuditRange(tx, { orgId, from, to })` — **this story's export flow must import and call it, never reimplement HMAC recomputation** (Story 8.1's own cross-story-context row for 8.2 already states this expectation: `8-1-tamper-evident-audit-log-with-hmac-integrity.md:123`).
- `apps/api/src/modules/audit/routes.ts`, `schema.ts` already exist (created by Story 8.1) with one route (`GET /audit/verify`) and its schemas. **This story adds new route registrations to the same `routes.ts` and new Zod schemas to the same `schema.ts`** — do not create a second routes file for the audit module (`modules/audit/routes.ts` is the one file per Story 8.1's D2 convention, mirroring every other feature module's single `routes.ts`).
- `computeAuditHmac()` (`write-entry.ts`), `currentAuditKeyVersion()` (`key-version.ts`), `firstActorTokenIdForUser()` (`actor-token.ts`), `writeHumanAuditEntry()`/`writeHumanAuditEntryOrFailClosed()` are all Story 8.1 deliverables this story reads but does not modify.
- **Do not modify `packages/db/src/schema/audit-log-entries.ts`'s existing columns** — this story only *adds* one new index to it (D5) and reads existing columns; it does not change the write path.

### D2 — Retention pruning cannot use a plain `DELETE`: Story 8.1's append-only trigger + grant REVOKE blocks it (adversarial-review-grade finding — read this before writing the retention job)

- epics.md's literal FR70 AC (`epics.md:1926`) says "a daily pg-boss job prunes rows older than the retention window." **A naive `DELETE FROM audit_log_entries WHERE created_at < cutoff` using the app's normal DB role will fail twice over**, because Story 8.1 already ships (via Epic 1's anticipatory migrations, confirmed present in this worktree):
  1. `packages/db/src/migrations/0001_rls_and_triggers.sql:58-69` — `prevent_audit_log_mutation()` trigger, `RAISE EXCEPTION` on any `UPDATE OR DELETE`.
  2. `packages/db/src/migrations/0002_audit_log_revoke.sql` — `REVOKE UPDATE, DELETE ON audit_log_entries FROM vault_app` (defense-in-depth at the grant layer, independent of the trigger).
- Both layers exist specifically so that **no ordinary application code path — including a future retention job someone adds without reading this — can accidentally delete audit rows**. Retention pruning is a real, intentional exception to "append-only," and it must be threaded through *both* layers explicitly, narrowly, and auditably. Restoring a blanket `GRANT DELETE ON audit_log_entries TO vault_app` would silently reopen the exact hole the REVOKE was added to close (any future SQL-injection or logic bug in *any* route could then delete audit rows) — **do not do this**.
- **Decision implemented in this story:** a single `SECURITY DEFINER` Postgres function, owned by the migration-runner role (not `vault_app`), is the only sanctioned deletion path. **Critical, adversarial-review-driven correction:** an earlier draft of this function trusted its `p_org_id` argument blindly — since `SECURITY DEFINER` already bypasses RLS by design, that would have made "pass the right UUID" the *only* tenant-isolation guard on a broadly-`EXECUTE`-granted function, i.e. a SQL-injection or logic bug anywhere else in the app that could reach this function could delete another org's audit rows outright. **The function below closes that gap by checking the caller's own RLS session context (`app.current_org_id`, the same setting every other org-scoped policy already relies on, see `0001_rls_and_triggers.sql:47-50`) against `p_org_id` before deleting anything** — the function becomes inert unless invoked inside a transaction that has already established RLS scope for that exact org, which is a materially stronger guarantee than "trust the argument":

```sql
-- New in migration 0030 (D2). Owned by the migration role (whoever runs `drizzle-kit migrate`,
-- NOT vault_app) — SECURITY DEFINER functions execute with the *owner's* privileges, so this
-- function can DELETE even though vault_app itself still cannot.
CREATE OR REPLACE FUNCTION purge_expired_audit_log_entries(p_org_id uuid, p_cutoff timestamptz)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted bigint;
  v_session_org uuid;
BEGIN
  -- Defense-in-depth (adversarial-review finding, critical): SECURITY DEFINER bypasses RLS,
  -- so "the caller passed the right p_org_id" cannot be the only tenant-isolation guard here.
  -- Require the caller's own transaction-scoped RLS org context to match p_org_id exactly —
  -- this is the same app.current_org_id convention every org-scoped RLS policy already uses,
  -- so any caller that has NOT gone through the normal org-scoped transaction setup (i.e. any
  -- unexpected/future code path) gets refused rather than silently trusted.
  v_session_org := NULLIF(current_setting('app.current_org_id', true), '')::uuid;
  IF v_session_org IS NULL OR v_session_org <> p_org_id THEN
    RAISE EXCEPTION 'purge_expired_audit_log_entries: p_org_id (%) does not match the session''s RLS org context (%)', p_org_id, v_session_org;
  END IF;

  PERFORM set_config('app.audit_retention_purge', 'true', true); -- session-local (true = is_local)
  DELETE FROM audit_log_entries WHERE org_id = p_org_id AND created_at < p_cutoff;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  PERFORM set_config('app.audit_retention_purge', 'false', true);
  RETURN v_deleted;
END;
$$;
--> statement-breakpoint

-- The trigger gains exactly one new escape hatch: DELETE is allowed only while the
-- above function's session-local flag is set. UPDATE is never allowed, under any flag —
-- retention only ever deletes whole rows, never mutates them.
CREATE OR REPLACE FUNCTION prevent_audit_log_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('app.audit_retention_purge', true) = 'true' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit_log_entries is append-only: UPDATE and DELETE are forbidden';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- vault_app is granted EXECUTE on the function ONLY — never a raw DELETE grant. The
-- function's own internal p_org_id/session-context check (above) is what keeps this
-- broad EXECUTE grant safe despite SECURITY DEFINER's RLS bypass.
GRANT EXECUTE ON FUNCTION purge_expired_audit_log_entries(uuid, timestamptz) TO vault_app;
```

  - The retention worker (`apps/api/src/workers/audit-retention-prune.ts`, new) iterates orgs **inside the same per-org, RLS-scoped transaction helper every other per-org worker already uses** (matching `prune-credential-versions.ts`/`prune-revoked-tokens.ts`'s existing pattern of opening one transaction per org and setting `app.current_org_id` for that org before doing any work) — it is this transaction-scoped `set_config('app.current_org_id', orgId, true)` that the function's internal check above relies on. Inside that transaction it calls `tx.execute(sql`SELECT purge_expired_audit_log_entries(${orgId}, ${cutoff})``)` — one call per org with a configured `retentionDays`, never a raw `DELETE`/`.delete()` Drizzle call against `auditLogEntries`, and never a call with an org ID that doesn't match the transaction's own RLS context.
  - **Do not** attempt to `ALTER TABLE ... DISABLE TRIGGER` around the delete — that is racy under concurrency (a concurrent audit write in another transaction could land while the trigger is disabled with no protection) and is not how the rest of this codebase's "escape hatch" patterns work (compare to `writeHumanAuditEntryOrFailClosed`'s explicit, narrow exception classes rather than blanket bypasses).
  - This is auditable, reversible (the SQL function can be dropped without touching application code), and preserves the exact defense-in-depth posture Story 8.1 established — `vault_app` still cannot run an ad-hoc `DELETE`/`UPDATE` against `audit_log_entries` under any normal code path; only this one reviewed function, invoked only by the retention worker with a matching RLS org context, can, and even a misuse of the function from a future code path is refused rather than silently trusted.

### D3 — Webhook forwarding delivery mechanism: a watermark-cursor catchup job, not a per-write synchronous call

- epics.md says "webhook forwards each new `audit_events` row as a JSON POST within 60 seconds of insertion" (`epics.md:1924`). The naive reading — hook a webhook POST into every audit-write call site — would require modifying `writeHumanAuditEntry()`, `secure-route.ts`'s default audit writer, and `writeHumanAuditEntryOrFailClosed()` (all Story 8.1 deliverables), and would mean an external HTTP call either (a) blocks the same DB transaction as the triggering business action (unacceptable — a slow/hanging webhook must never delay or fail a credential access), or (b) fires before the transaction commits, racing against row visibility.
- **Decision implemented in this story:** reuse this codebase's existing "durable row + resilient catchup cron" pattern (already established by the notification system — see `apps/api/src/modules/auth/routes.ts:83-93`'s documented rationale: "a missed `boss.send()` is safe — the row is still durable and the catchup cron will pick it up"). `audit_log_entries` is *already* the durable, immutable source of truth — no new queue table is needed to make writes durable.
  - `audit_forwarding_config` (new table, D-schema below) carries a per-org cursor: `lastForwardedCreatedAt`, `lastForwardedId` (composite watermark, since `created_at` alone is not unique), and `consecutiveFailureCount`.
  - A new pg-boss **schedule**, `audit:webhook-forward-catchup`, cron `* * * * *` (every minute — the finest granularity already used elsewhere, e.g. `security/check-failed-auth-threshold`), iterates every org with `type = 'webhook' AND enabled = true`, queries `audit_log_entries WHERE org_id = :orgId AND (created_at, id) > (:cursorCreatedAt, :cursorId) ORDER BY created_at, id LIMIT 500`, POSTs each row as JSON, and — **only after each individual POST succeeds** — advances the cursor to that row before moving to the next.
  - **This means the documented delivery SLA is "within ~60-120 seconds of insertion, best-effort"** (worst case: a row inserted 1 tick after the minute rolls over is picked up on the *next* tick, up to ~2 minutes later under this design), not a hard sub-60-second guarantee. This is an honest interpretation of epics.md's "within 60 seconds" as a target, not a literal SLA the architecture can promise without a synchronous or sub-minute-cron mechanism neither epics.md nor the existing pg-boss schedule granularity supports. Document this trade-off explicitly in the route's OpenAPI description and in Dev Notes — do not silently under-deliver against an implied stricter SLA.
  - **Failure handling (bounded, not infinite-retry):** if a POST fails (non-2xx, timeout, DNS/connection error), the cursor does **not** advance past that row, and `consecutiveFailureCount` increments; the same row is retried on the next tick. After `AUDIT_WEBHOOK_MAX_CONSECUTIVE_FAILURES = 10` (roughly 10 minutes of continuous failure at 1/min), the job sets `audit_forwarding_config.enabled = false` for that org, logs an operational error (`OperationalEvent`-style structured log), and stops attempting further delivery until an admin re-`PUT`s the config (which resets `consecutiveFailureCount` to 0 and re-enables). **A permanently-broken webhook URL does not silently drop rows forever or spin the CPU forever** — it fails loud (in logs) and stops, and the cursor position is preserved so re-enabling resumes exactly where it left off, not from the current moment (no silent gap).
  - This design requires **zero changes to any Story 8.1 file** — `write-entry.ts`, `human-entry.ts`, `secure-route.ts`, `audit-or-fail-closed.ts` are untouched. All new logic lives in this story's own new files.
  - **Adversarial-review correction — the S3 daily batch (AC-19) needs this same bounded-failure watermark design, not a bare "query yesterday and hope" job (high):** an earlier draft of this story gave the S3 cron no cursor and no failure handling at all — it queried "the previous UTC day's rows" fresh every run, so a single failed `PutObjectCommand` (network error, bad credentials, `NoSuchBucket`) would silently and *permanently* drop that day's compliance export, since tomorrow's run only ever looks at "yesterday" relative to itself, never revisiting a day it failed. **Decision implemented in this story: `audit_forwarding_config` also carries `s3LastForwardedDate` (date, nullable) and `s3ConsecutiveFailureCount` (int, default 0) for `type = 's3'` rows.** The daily `audit:s3-forward-daily` cron, per org, computes the oldest not-yet-forwarded UTC day (`s3LastForwardedDate + 1 day`, or `yesterday` if `s3LastForwardedDate IS NULL`) and attempts to forward **that** day first — advancing `s3LastForwardedDate` only after a successful upload, and never skipping ahead to "today's yesterday" while an earlier day remains unforwarded (mirroring the webhook cursor's "don't skip a failed row" rule from AC-18). On failure, `s3ConsecutiveFailureCount` increments and the same day is retried on the next day's run; after `AUDIT_S3_MAX_CONSECUTIVE_FAILURES = 5` (five consecutive failed daily attempts), the job sets `enabled = false` for that org's S3 config, logs a structured operational error, and stops — identical shape to the webhook's `AUDIT_WEBHOOK_MAX_CONSECUTIVE_FAILURES = 10` auto-disable in AC-18, just a longer failure window matched to a once-a-day cadence instead of once-a-minute. This closes the "S3 forwarding can silently and permanently drop a day of compliance data" gap and makes both forwarding mechanisms fail loud-and-stop rather than fail silent-and-continue.

### D4 — Outbound webhook (and S3 `endpoint`) fetch needs SSRF protection; none exists anywhere in this codebase today

- Grep confirms zero existing outbound-HTTP-to-user-supplied-URL code in `apps/api/src` (the Slack webhook in `admin/routes.ts` uses a fixed `env.SLACK_WEBHOOK_URL`, an operator env var, not a per-org user-supplied URL). This story is the **first** place the app makes outbound HTTP requests to a URL an org admin controls — a classic SSRF vector (an admin, or an attacker who compromises an admin session, could point the webhook at `http://169.254.169.254/...` cloud metadata, `http://localhost:<internal-port>/...`, or an internal service).
- **Decision implemented in this story:** new shared utility `apps/api/src/lib/safe-fetch.ts` exporting `safeFetchExternal(url, init, opts)`:
  - Rejects any URL whose scheme is not `https:` (webhook config validation, D-schema below, already requires `https://` at the Zod-schema layer — this is defense-in-depth at the actual-fetch-time layer too, in case config was written before a stricter policy existed).
  - Resolves the hostname via `dns.promises.lookup(hostname, { all: true })` **before** connecting, and rejects if **any** resolved address falls in a private/loopback/link-local/multicast range (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `127.0.0.0/8`, `169.254.0.0/16`, `::1`, `fc00::/7`, `fe80::/10`) — implemented with Node's built-in `net.isIP` plus a small CIDR-range-check helper (no new dependency needed; this is straightforward bitwise arithmetic over parsed IPv4/IPv6 octets, not worth adding a package for).
  - **Adversarial-review correction — DNS rebinding / TOCTOU (high):** validating the hostname's resolved address and then letting the HTTP client (`fetch`/undici) re-resolve the same hostname at connect time is not sufficient — a malicious DNS server can return a safe public IP for the pre-check and a private/internal IP moments later for the real connection, since nothing pins the two lookups together. **Fix: pin the validated IP for the actual connection.** `safeFetchExternal` passes a custom `lookup` function (matching Node's `dns.lookup` callback signature) into undici's `Agent`/`Dispatcher` `connect` options (or, if driving the request via Node's `https.request` directly, sets `options.lookup` on the request) that returns **only the exact address(es) already validated** — never performing a second, independent DNS resolution at connect time. The TLS `servername` (SNI) is still set to the original hostname so certificate validation is unaffected; only the IP the socket actually connects to is pinned. This closes the gap without needing a second dependency (Node's `http(s)` and undici both support a `lookup` override natively).
  - **Adversarial-review correction — redirect-following bypass (high):** the fetch is issued with `redirect: 'manual'` — **3xx responses are never automatically followed.** A webhook target that initially resolves to a safe public host could otherwise respond with a redirect (e.g., to `http://169.254.169.254/...` or an internal service) and have that redirect followed by default `fetch()`/undici behavior, silently defeating the DNS/IP validation above. `safeFetchExternal` treats any `3xx` response as a plain delivery failure (same as a `5xx` or timeout, feeding into D3's webhook consecutive-failure counter) — it never re-validates and re-fetches a `Location` header automatically. A compliance-SIEM webhook ingest endpoint has no legitimate reason to redirect; if an operator's endpoint does redirect, that is treated as a misconfiguration to fix at the source (a stable, direct ingest URL), not a case this story's fetch utility follows.
  - Enforces a connect+total timeout (`WEBHOOK_FETCH_TIMEOUT_MS = 5_000`) via `AbortController`.
  - Caps response body read at a small size (the webhook response body is never used for anything beyond status-code success/failure — do not read or log an unbounded response body).
  - This utility is intentionally placed in `apps/api/src/lib/` (general infra, not `modules/audit/`) since it is the correct home for any future outbound-integration feature that needs the same SSRF protection — but no other consumer exists yet in this story besides webhook delivery and (per below) S3 `endpoint` validation at configuration time; do not over-generalize its API beyond what this story needs.
  - **Adversarial-review correction — S3 `endpoint` is admin-controlled and was previously left unvalidated (high):** an earlier draft of this story argued S3/Minio forwarding "does not need this utility" because it requires valid AWS-style credentials — but D9's `endpoint` field (added beyond epics.md's literal field list, specifically to support Minio) is set by the **same org-admin-controlled input** as the webhook URL, and an admin supplying their own `accessKeyId`/`secretAccessKey` alongside a malicious `endpoint` trivially "authenticates" against infrastructure they themselves control. This is the same trust boundary as the webhook, not a materially different one, and it must not ship unprotected. **Decision: `safeFetchExternal`'s hostname-validation logic is extracted into a standalone, reusable check, `assertPublicHostname(hostnameOrUrl): Promise<void>` (same DNS-resolution + private-range-rejection logic, no HTTP fetch performed), and `PUT /audit/forwarding` calls it against `config.endpoint` whenever an S3 config supplies one, at configuration time** (before the row is upserted), rejecting with the same `422 { code: "unsafe_forwarding_url" }` shape used for webhook URLs. This is validate-at-configure-time, not connection-time IP-pinning like the webhook path (the AWS SDK manages its own HTTP client internally, so pinning its actual socket connection is out of scope for this story) — document this narrower scope explicitly in Dev Notes rather than silently leaving a gap: a determined attacker who can still manipulate DNS *after* configuration time (post-validation) to rebind a validated `endpoint` hostname could still redirect the daily S3 upload, which is a real but meaningfully narrower window (once per admin-initiated config change, not once per delivery) than the fully-unvalidated original design. A future story hardening the S3 client's actual connection (e.g., a custom SDK `requestHandler` with the same `lookup`-pinning technique) is a reasonable follow-up, not a blocker for this story.

### D5 — New index required: epics.md's literal AC needs `(actor_token_id, created_at)`, which does not exist in the shipped schema

- epics.md's Story 8.2 AC (`epics.md:1914`) requires indexes on `(actor_id, timestamp)`, `(project_id, timestamp)`, `(event_type, timestamp)`, `(resource_id, timestamp)`. Reading the actual shipped schema (`packages/db/src/schema/audit-log-entries.ts`, confirmed by direct read): `projectIdx`, `eventTypeIdx`, `resourceIdx` **already exist** (all `(column, created_at DESC)`), but there is **no index on `actor_token_id` at all** — epics.md's `actor_id` maps to this codebase's `actor_token_id` column (Story 8.1's D1 naming-divergence precedent), and it is currently unindexed.
- **Decision implemented in this story:** new migration adds `idx_audit_log_entries_actor_token ON audit_log_entries (actor_token_id, created_at DESC)`, and the Drizzle schema file (`audit-log-entries.ts`) gains the corresponding index definition. **This is the one column-level schema change this story makes to `audit_log_entries`** — everything else about that table (columns, RLS, triggers, grants) is untouched, per D1.

### D6 — `actorId` query parameter resolves through `user_identity_tokens`, not a raw `actor_token_id`

- epics.md's literal query parameter is `actorId=` (`epics.md:1913`). A compliance officer knows a user's actual **user ID** (or would look one up via `GET /api/v1/org/users`) — they do not know, and should never need to know, the internal `actor_token_id` surrogate. **Decision implemented in this story:** `GET /audit/events?actorId=<userId>` resolves `actorId` to the corresponding `user_identity_tokens.id` value(s) (`WHERE user_id = :actorId`) inside the search service, then filters `audit_log_entries.actor_token_id IN (...)`. If no `user_identity_tokens` row exists for the given `actorId` (e.g., a typo'd UUID, or a user ID that never had a token created), the query resolves to zero token IDs and the search returns an **empty result set** (`200`, `rowsChecked: 0`-shape response), not a `404` — a valid-shaped-but-nonexistent filter value is a legitimate "no matches" case, matching this codebase's general convention (compare Story 8.1 AC-7's empty-range handling).
- `user_identity_tokens.user_id` is not declared `UNIQUE` in the schema (`packages/db/src/schema/user-identity-tokens.ts` — no unique index on `user_id`); the resolution query must not assume at most one row and should use `IN (...)` over however many token rows match, for defensive correctness even though today's registration flow (Story 1.6) creates exactly one per user.

### D7 — Retention bounds: no tier system exists, so this story picks a platform-wide default, not a per-tier ceiling

- See "Out of scope" above for the full reasoning. **Decision implemented in this story:** `AUDIT_RETENTION_MIN_DAYS = 30` (a compliance floor — SOC2/ISO27001 practice generally expects at least a rolling month of security-relevant records; rejecting anything shorter prevents an admin from accidentally configuring "retain 1 day" and losing evidentiary value) and `AUDIT_RETENTION_MAX_DAYS = 3650` (10 years — a generous ceiling that is really just an input-sanity bound, not a business rule) are named constants in `apps/api/src/modules/audit/retention.ts`. `retentionDays: null` is a valid, explicit "retain forever, no automatic pruning" state (the default for a newly-created org, matching the principle that data is never silently deleted by a feature an admin never configured).

### D8 — Export file storage: same-origin DB-backed download, not a pre-signed external URL

- epics.md's literal wording — "`GET /api/v1/org/audit/exports/:jobId` returns status and download URL when complete" (`epics.md:1920`) — could be read as implying a pre-signed S3-style URL. **This codebase provisions no object storage for internal application use** (S3 in this story is exclusively the *operator-configured external forwarding destination*, a distinct concept from where the vault stages its own generated export files — see D3/D9). Provisioning a *second*, internally-managed object-storage dependency purely to host generated CSVs, on top of the *optional, admin-configured* forwarding S3 target, would be over-engineering for a self-hosted single-Postgres-instance architecture.
- **Decision implemented in this story:** the generated CSV (gzip-compressed) is stored directly in a new `bytea` column (`audit_exports.file_content`) in Postgres. `downloadUrl` in the job-status response is a same-origin API path: `/api/v1/org/audit/exports/:jobId/download` — a new `GET` route that streams the decompressed CSV with `Content-Type: text/csv` and `Content-Disposition: attachment; filename="audit-export-<jobId>.csv"`. This is simpler, requires no new external infrastructure dependency, and matches the architecture's self-hosted-first posture. Total export size is bounded (`AUDIT_EXPORT_MAX_ROWS_TOTAL`, D-schema below) specifically so this bytea column never grows unboundedly.

### D9 — New dependencies required: `@aws-sdk/client-s3` (new); CSV serialization is hand-rolled (no new dependency)

- Grep confirms zero existing CSV-generation code and zero AWS SDK usage anywhere in this repo. **Decision implemented in this story:**
  - Add `@aws-sdk/client-s3` (latest stable v3, pinned like other deps in `apps/api/package.json`) — needed for real SigV4-signed S3 API calls (`PutObjectCommand`) against both AWS S3 and S3-compatible endpoints (Minio) via the SDK's `endpoint` client-config option (epics.md's AC-E8b explicitly requires Minio support, which needs a configurable, non-AWS endpoint — this is a necessary addition beyond epics.md's literal `config` field list, which omits `endpoint`; document this in the schema as an intentional extension, not a deviation). **This `endpoint` field is validated via D4's `assertPublicHostname()` at configuration time** — see D4's adversarial-review correction; it is not exempt from SSRF review just because it flows through the AWS SDK rather than a bare `fetch`.
  - **Do not** add a CSV library — the column set is small and fixed (8 columns per AC-E8c), and this codebase's dependency philosophy is visibly minimal (compare: no lodash, no axios, hand-rolled canonical-JSON in `write-entry.ts`). A small `toCsvRow()` helper (`apps/api/src/modules/audit/csv.ts`, new) implements RFC 4180 quoting: wrap a field in `"..."` and double any embedded `"` if the field contains a comma, quote, `\r`, or `\n`. Unit-test this helper directly against all four trigger characters plus a plain field (AC-12).

---

## Prerequisites

| Prerequisite | Why | Status |
|---|---|---|
| **Story 8.1 (Tamper-Evident Audit Log with HMAC Integrity) — must be `done`, not just `ready-for-dev`** | Ships `audit_log_entries`, the append-only trigger/grant (which D2's migration modifies), `computeAuditHmac()`, `currentAuditKeyVersion()`, and — critically — `verifyAuditRange()`, which this story's export flow calls as a mandatory precondition. **This story's migration (D2) also assumes Story 8.1's exact trigger/grant SQL already exists in the migration history** (it `CREATE OR REPLACE`s the same trigger function) — if 8.1 has not landed, this story's migration has nothing to modify and must not be merged out of order. | `ready-for-dev` (not yet implemented in this worktree as of story creation — confirmed by grep: `apps/api/src/modules/audit/` contains no `routes.ts`, `verify.ts`, or `schema.ts` yet) |
| Story 1.4 (Database Foundation, RLS, core schema) | RLS/migration conventions this story's new tables follow | `done` |
| Story 1.6 (User Registration) | `user_identity_tokens` rows this story's `actorId` resolution (D6) reads | `done` |
| Story 1.11 (SecureRoute framework) | `secureRoute()`, transaction-scoped RLS context, rate limiting — this story's routes use the same framework | `done` |
| Epics 2–7 (audit-writing stories, `done`/`ready-for-dev`) | Populate `audit_log_entries` with the historical data this story searches/exports (PJ5 — no re-ingestion needed) | mixed — irrelevant to this story's correctness |
| `packages/db/src/migrations/meta/_journal.json` — latest migration is `0029_machine_users_and_api_keys.sql` (idx 29) at the time of this story's creation | **This story adds migration `0030`** — confirm no other story has claimed idx 30 before merging (check `_journal.json` again at implementation time; Story 8.1 claims no migration per its own D1/AC-16, so 0030 should still be free) | informational |

---

## Epic Cross-Story Context

| Story | Relationship to 8.2 |
|---|---|
| 8.1 (Tamper-Evident Audit Log, `ready-for-dev`) | This story's hard prerequisite (see above) and the source of `verifyAuditRange()`, `computeAuditHmac()`, the append-only trigger this story's migration extends (D2), and the `routes.ts`/`schema.ts` files this story extends rather than duplicates (D1). |
| 8.3 (Access Reports, Dormant Users & Audit PII Management, `backlog`) | Reuses this story's CSV-generation helper (`csv.ts`, D9) for its own access-report CSV (AC-E8c applies to both). Also: Story 8.3's pseudonymization changes `user_identity_tokens.display_name` — this story's export `actor_display_name` column (AC-12) reads that same field live at export time, so a pseudonymized user's historical audit rows correctly show their alias in exports generated *after* pseudonymization, with no changes needed here (the join is always by current `display_name`, never a frozen copy — this is a feature, not a bug, matching PJ6/AC-E8d's design that pseudonymization doesn't touch `audit_log_entries` rows themselves). **Adversarial-review flag (high), carried to Story 8.3 explicitly:** because `user_identity_tokens` is platform-level, not org-scoped, this live join also means a pseudonymization triggered by Org A silently changes audit-export rendering for that same user in every *other* org they belong to — Story 8.3 must explicitly decide whether that cross-org bleed is acceptable or requires an org-scoped display-name mechanism (see AC-13's "Known, explicitly-flagged limitation" note in this story). |
| 9.2 (System Settings, Multi-Org & Resource Monitoring, `backlog`) | Owns the eventual `instancePolicy`/tier concept (D7) — must revisit this story's `AUDIT_RETENTION_MIN_DAYS`/`MAX_DAYS` bounds to add real per-tier enforcement once tier data exists. Also owns `AUDIT_LOG_STORAGE_LIMIT_GB` monitoring of `audit_log_entries`' total table size (`epics.md:2055`) — a related but distinct concern from this story's per-org `retentionDays` pruning (that story's alert is about *aggregate* storage pressure across all orgs; this story's pruning is a *per-org, admin-configured* retention policy). No code sharing expected, but both jobs run daily pg-boss crons against the same table — worth a comment cross-reference when 9.2 is implemented. |
| 9.4 (Platform Operator Audit Log, `backlog`) | Structurally separate `platform_audit_events` table; does not reuse this story's search/export/forwarding endpoints (see "Out of scope"). |
| 7.1/7.2 (Machine User Identity/Auth, `ready-for-dev`, not yet implemented) | Once implemented, machine-user audit rows (`actor_type = 'machine_user'`) will have `actor_token_id: null` (Story 8.1's D3). This story's export `actor_display_name` column falls back to the literal string `'machine_user'` for such rows (see AC-13) — a known, explicitly-scoped limitation, not a full solution; Story 7.1/7.2 or a later story should revisit whether machine-user audit rows need a structured display-name path (e.g., joining through `machine_users.name`) once that schema's shape with respect to audit rows is finalized. |

---

## Architecture Conflict Resolution (Read Before Coding)

| Epic/Architecture wording | Canonical implementation for 8.2 | Rationale |
|---|---|---|
| epics.md: filter by `actorId` | Resolved via `user_identity_tokens.user_id → id` lookup, then filters `actor_token_id IN (...)` (D6) | `actorId` (a real user ID) is not the same value as the internal `actor_token_id` surrogate; callers should never need to know the surrogate |
| epics.md: indexes on `(actor_id, timestamp)` etc. | New index `idx_audit_log_entries_actor_token (actor_token_id, created_at DESC)`; other three already shipped by Story 8.1's anticipatory schema (D5) | Column name divergence (Story 8.1's D1 precedent); only one new index is actually needed |
| epics.md: retention job "prunes rows older than retention window" | `SECURITY DEFINER` function `purge_expired_audit_log_entries()`, invoked only by the retention worker inside a matching RLS-scoped transaction, with an internal `p_org_id`-vs-session-context check (D2) | A plain `DELETE` is blocked by Story 8.1's own append-only trigger + grant revoke; this is the narrow, auditable exception, and the internal check prevents the broad `EXECUTE` grant from becoming a cross-org deletion path (adversarial-review critical fix) |
| epics.md: webhook forwards "within 60 seconds of insertion" | Every-minute watermark-cursor catchup cron; documented as a ~60-120s best-effort target (D3) | No existing sub-minute cron granularity in this codebase; a synchronous per-write call would couple business-transaction latency/reliability to an external, admin-controlled URL |
| epics.md: config `{ url?, secretHeader?, bucket?, prefix?, region?, accessKeyId?, secretAccessKey? }` | Same fields, plus `endpoint?` (new, optional) for S3-compatible/Minio support; both `url` and `endpoint` are validated via `assertPublicHostname()` (D4) | epics.md's own AC-E8b requires Minio support, which needs a configurable endpoint the literal field list omits; the endpoint is admin-controlled the same way the webhook `url` is, so it gets the same SSRF check (adversarial-review high fix) |
| epics.md: export returns a "download URL" | Same-origin API path (`/audit/exports/:jobId/download`) backed by a Postgres `bytea` column, not a pre-signed external URL | No object storage is provisioned for internal use in this self-hosted architecture; avoids a second, unnecessary storage dependency |
| epics.md: "retentionDays (within subscription tier limits)" | Platform-wide `AUDIT_RETENTION_MIN_DAYS`/`MAX_DAYS` bound only; no tier enforcement | No tier/subscription concept exists anywhere in this codebase yet (D7) |

---

## Acceptance Criteria

### AC Quick Reference

| Area | Required result |
|---|---|
| Schema | New migration `0030`: `idx_audit_log_entries_actor_token` index (D5); new tables `audit_exports`, `audit_forwarding_config`, `audit_retention_config` (all org-scoped, RLS-enabled); new `purge_expired_audit_log_entries()` SECURITY DEFINER function + trigger amendment (D2). |
| `GET /audit/events` | `allowedRoles: ['owner']`. Filters by `actorId`, `eventType`, `resourceId`, `projectId`, `from`, `to` simultaneously; paginated. |
| `POST /audit/export` | `allowedRoles: ['owner']`, `requireMfa: true`. Runs mandatory integrity verification first (chunked across ≤90-day sub-ranges); on pass, generates CSV + integrity summary row; async via pg-boss, returns `jobId` immediately. |
| `GET /audit/exports/:jobId` | `allowedRoles: ['owner']`. Returns job status + `downloadUrl` when complete. |
| `GET /audit/exports/:jobId/download` | `allowedRoles: ['owner']`. Streams the CSV. |
| `PUT /audit/forwarding` | `minimumRole: 'admin'`, `requireMfa: true`. Configures webhook or S3 forwarding; secrets encrypted at rest; SSRF-guarded via `assertPublicHostname()` for both webhook `url` and S3 `endpoint` (D4). |
| `PUT /audit/retention` | `minimumRole: 'admin'`, `requireMfa: true`. Sets `retentionDays` within platform bounds (D7). |
| Webhook delivery | Every-minute watermark-cursor catchup cron (D3); IP-pinned, non-redirect-following delivery via `safeFetchExternal()`; auto-disables after 10 consecutive failures. |
| S3 delivery | Daily gzipped-JSONL batch cron per org with its own watermark cursor (`s3LastForwardedDate`); auto-disables after 5 consecutive failed days (D3). |
| Retention pruning | Daily cron calling the SECURITY DEFINER purge function (D2), org-scoped, with an internal tenant-context check against the caller's RLS session. |
| Tenant isolation | Every new table and every query is org-scoped; RLS + explicit cross-org tests. |
| Migration safety | New migration only adds objects; touches no existing column; `prevent_audit_log_mutation()` gains exactly one conditional branch, `UPDATE` remains unconditionally forbidden. |
| Integration tests | Cover every AC below. |

---

### AC-1: Search — Happy Path, All Filter Dimensions Simultaneously

**Given** an org has audit rows spanning several event types, actors, resources, and projects, including one row matching all of: `actorId = <userId>`, `eventType = 'credential.value_revealed'`, `resourceId = <credId>`, `projectId = <projId>`, `createdAt` within `[from, to]`,

**When** an org owner calls
`GET /api/v1/org/audit/events?actorId=<userId>&eventType=credential.value_revealed&resourceId=<credId>&projectId=<projId>&from=2026-07-01T00:00:00.000Z&to=2026-07-04T23:59:59.999Z&page=1&limit=20`,

**Then** the response is `200`:

```json
{
  "data": [
    {
      "id": "a1b2...-uuid",
      "eventType": "credential.value_revealed",
      "actorDisplayName": "Alice Chen",
      "resourceId": "c3d4...-uuid",
      "resourceType": "credential",
      "projectId": "e5f6...-uuid",
      "ipAddress": "203.0.113.10",
      "createdAt": "2026-07-03T14:22:01.000Z"
    }
  ],
  "page": 1,
  "limit": 20,
  "total": 1,
  "hasNext": false
}
```

**And** only rows matching **all five** provided dimensions are returned — a row matching four of five is excluded; this is verified by a test that inserts one row matching all five and three "near-miss" rows each differing in exactly one dimension, asserting exactly one result.

**And** the query plan for this filter combination uses the indexes from D5 (existing `projectIdx`/`eventTypeIdx`/`resourceIdx` plus the new `actorTokenIdx`) — verified by an `EXPLAIN ANALYZE` assertion in a seeded-volume test. **Practical scale note:** epics.md cites 1M rows (NFR-PERF6); seeding a literal 1M rows in every CI run is impractical for suite runtime. This story's perf test seeds a representative volume (documented constant, e.g. 20,000 rows across the filtered dimensions) sufficient to force the planner off a sequential scan, and asserts `Index Scan`/`Bitmap Index Scan` appears in the `EXPLAIN ANALYZE` output for each single-dimension filter — not a literal 1M-row timing benchmark. Document this scale trade-off in the test file's header comment so a future reader doesn't mistake it for the full NFR-PERF6 validation.

---

### AC-2: Search — `actorId` Resolution Through `user_identity_tokens` (D6)

**Given** user Alice has exactly one `user_identity_tokens` row and 3 audit rows referencing it,

**When** an owner calls `GET /api/v1/org/audit/events?actorId=<alice's userId>`,

**Then** all 3 rows are returned — the search service resolves `actorId` → `user_identity_tokens.id` internally, filters `actor_token_id IN (...)`, and the caller never sees or supplies a raw `actor_token_id`.

**Edge case — unknown/never-tokenized `actorId`:** **Given** `actorId` is a syntactically valid UUID with no matching `user_identity_tokens` row (e.g., copy-paste typo, or a user ID from a different, unrelated system), **when** the same endpoint is called, **then** the response is `200` with `data: [], total: 0` — **not** `404` and **not** `422`. A well-formed filter that matches nothing is a legitimate empty result (consistent with Story 8.1 AC-7's empty-range precedent), not an error.

**Edge case — multiple token rows for one user (defensive, not expected in current registration flow):** **Given** (via direct test-fixture insert, since the normal flow never produces this) two `user_identity_tokens` rows share the same `user_id`, **when** searching by that `actorId`, **then** rows referencing **either** token are returned (`IN (...)`, not `= (single value)`) — verified by an explicit test, since `user_identity_tokens.user_id` has no `UNIQUE` constraint in the schema and a future code path could create more than one.

---

### AC-3: Search — Historical Events From Epics 2–7 Queryable Without Re-Ingestion (PJ5)

**Given** audit rows exist that were written by code shipped in Epics 2–7 (simulated in tests by inserting rows via `writeHumanAuditEntry()` directly, tagged with `eventType` values like `'credential.created'`, `'rotation.initiated'`, `'project.archived'` — i.e., not written through any 8.2-specific code path),

**When** the search endpoint filters by those event types or date ranges predating this story's implementation,

**Then** they are returned identically to rows written after this story ships — there is no "epoch" column, no re-ingestion step, and no schema migration touches existing row data (D1). This is testable as: insert rows with `createdAt` backdated to before this story's hypothetical ship date, and confirm the search endpoint returns them with no special-casing.

---

### AC-4: Search — Query Validation

**Given** an authenticated owner,

**When** they call the endpoint with any of the following, tested independently:

| Query | Expected response |
|---|---|
| `actorId=not-a-uuid` | `422 { code: "validation_error", details: { actorId: [...] } }` |
| `resourceId=not-a-uuid` | `422` (same shape) |
| `projectId=not-a-uuid` | `422` (same shape) |
| `from=garbage&to=2026-07-04T00:00:00.000Z` | `422` — Zod `z.iso.datetime()` rejects malformed `from` |
| `from` after `to` | `422 { code: "invalid_range" }` |
| `page=0` or `page=-1` | `422` — `page` must be `>= 1` (matches `PageLimitQueryShape` convention) |
| `limit=101` | `422` — `limit` capped at 100 (matches `PageLimitQueryShape`) |
| No filters at all, no `from`/`to` | **Not an error** — returns the most recent page of **all** the org's audit rows, newest first; every filter dimension including `from`/`to` is optional per epics.md's literal query-param list (`epics.md:1913` lists them without a "required" designation) |

**Then** each case is verified by an independent test.

---

### AC-5: Search — Pagination Depth Guard

**Given** an org with 50,000 audit rows and no narrowing filter applied,

**When** an owner requests `page=2001&limit=20` (offset `40,000`, exceeding a documented cap),

**Then** the response is `422 { code: "page_out_of_range", message: "Page is too deep; narrow your filters" }` — reusing the existing `resolvePaginationOffset()`/`PAGE_OUT_OF_RANGE_ERROR` helper (`apps/api/src/lib/pagination.ts`) with a new named cap `AUDIT_EVENTS_MAX_OFFSET = 10_000`, the same pattern already used by credentials/machine-user list endpoints — **no new pagination-depth mechanism is invented for this story.**

**And** a request within the cap (e.g., `page=500&limit=20`, offset `9,980`) succeeds normally, confirming the boundary is exclusive of the cap itself, not off-by-one.

---

### AC-6: Search — Authorization: Owner-Only, and Tenant Isolation

**Given** an authenticated user with `orgRole: 'admin'`, `'member'`, or `'viewer'` (tested independently),

**When** they call `GET /api/v1/org/audit/events`,

**Then** the response is `403 { code: "insufficient_role" }` — matching Story 8.1's `verify` endpoint precedent exactly (`allowedRoles: ['owner']`, same `hasSufficientRole()` check).

**And**, using `withTwoTestOrgs()`: org A has 5 audit rows, org B has 3; org A's owner's search over a range covering both orgs' timestamps returns exactly org A's rows (`total: 5`, never `8`) — RLS makes org B's rows structurally invisible, verified the same way as Story 8.1's AC-5.

---

### AC-7: Search — This Endpoint's Own Calls Are Audited

**Given** Story 8.1's D7 precedent (verify calls are themselves audited, since "who searched/verified the audit log" is itself forensic evidence),

**When** an owner calls `GET /audit/events` with any filter combination,

**Then** the route registers `writeAuditEvent: true` with `eventType: 'audit.search_run'`, `payload: { actorId, eventType, resourceId, projectId, from, to, resultCount }` — reusing the standard `SecureRoute` audit writer, no new write-path code. **Rate limit chosen accordingly:** `60/min` per user (browsing/paging through results is expected to be more frequent than Story 8.1's CPU-bound `verify` calls, hence a higher tier than that endpoint's `20/min`, but still bounded).

---

### AC-8: Search — Concurrency: New Writes During Paginated Browsing

**Given** an owner is paging through search results (`page=1`, then `page=2`, ...) while new audit rows matching the filter are being written concurrently by other requests,

**When** both proceed concurrently,

**Then** no crash, no torn read occurs; standard offset-pagination semantics apply — a new row inserted between two page fetches may shift which rows appear on which page (a well-known, accepted limitation of offset pagination, not a bug this story fixes with keyset pagination, since epics.md's literal `page=&limit=` query params imply offset pagination, matching every other list endpoint in this codebase). **Test asserts:** total row count returned across all pages, summed, is internally consistent with a single point-in-time `total` snapshot taken at the start of the test (not asserting a specific row's page position, which is legitimately non-deterministic under concurrent writes).

---

### AC-9: Export — Happy Path Trigger

**Given** an org owner is authenticated,

**When** they call `POST /api/v1/org/audit/export` with body `{ "from": "2026-06-01T00:00:00.000Z", "to": "2026-07-01T00:00:00.000Z", "format": "csv", "includeIntegrityReport": true }`,

**Then** the response is `202`:

```json
{ "data": { "jobId": "f7e8...-uuid", "status": "pending" } }
```

**And** a row is inserted into `audit_exports` (`status: 'pending'`) in the same request transaction, and a pg-boss job (`audit:export`, payload `{ exportId: jobId }`) is enqueued **after** that transaction commits (mirroring the existing `notification:backfill-pending-delivery`-style post-registration `boss.send()` pattern already used in `main.ts`) — the HTTP response never waits for CSV generation to complete.

---

### AC-10: Export — Mandatory Integrity Verification First, Chunked Across ≤90-Day Sub-Ranges

**Given** an export request spans `[from, to] = 200 days`,

**When** the `audit:export` worker processes the job,

**Then** it calls `verifyAuditRange()` (Story 8.1) once per ≤90-day sub-range covering the full `[from, to]` span (matching Story 8.1's D4 documented per-call cap of `AUDIT_VERIFY_MAX_RANGE_DAYS = 90`/`AUDIT_VERIFY_MAX_ROWS = 50,000`), aggregates `rowsChecked`/`passed`/`failed`/`failedCount` across all chunks, and only proceeds to CSV generation if **every** chunk's verification passes (`failedCount === 0` across the aggregate). **This is a background job, not an interactive call, so chunking here is invisible to the caller** — they see one `jobId`, one final result — unlike Story 8.1's `verify` endpoint, which requires the *caller* to make multiple calls for long ranges.

**And** the total requested range is itself bounded: `AUDIT_EXPORT_MAX_RANGE_DAYS = 400` (named constant, `apps/api/src/modules/audit/export.ts`) — a request exceeding this is rejected at the `POST` route layer (`422 { code: "range_too_large" }`) before any job is even enqueued, distinct from the per-chunk verify cap (this bounds total job runtime, not a single verify call).

---

### AC-11: Export — Verification Failure Fails the Export Closed

**Given** one row within the requested export range has been tampered with (inserted with a self-inconsistent `hmac`, per Story 8.1 AC-2's insert-time-tampering test technique),

**When** the `audit:export` worker runs verification,

**Then** the job transitions to `status: 'failed'`, `errorReason: 'integrity_check_failed'`, and **no CSV is generated or stored** — `audit_exports.file_content` remains `NULL`. `GET /audit/exports/:jobId` reflects `{ status: "failed", errorReason: "integrity_check_failed", integritySummary: { rowsChecked, passed, failedCount, failed: [...] } }` so the compliance officer sees exactly which rows failed and why, without ever receiving a CSV that silently omitted or misrepresented tampered data. This is the single most important failure mode in this story: **an export must never appear to succeed while integrity verification failed** — the API contract makes fail-closed observable, not silent.

---

### AC-12: Export — CSV Format and Integrity Summary Row

**Given** verification passes for a 3-row range,

**When** the CSV is generated,

**Then** it contains exactly the columns from AC-E8c in this order — `timestamp,actor_display_name,event_type,resource_id,resource_type,org_id,project_id,ip_address` — one data row per audit row, RFC 4180 quoted (D9's `toCsvRow()`), followed by a final integrity-summary row:

```csv
timestamp,actor_display_name,event_type,resource_id,resource_type,org_id,project_id,ip_address
2026-07-03T14:22:01.000Z,Alice Chen,credential.value_revealed,c3d4...-uuid,credential,e5f6...-uuid,proj1...-uuid,203.0.113.10
2026-07-03T15:01:09.000Z,Bob Singh,rotation.initiated,d4e5...-uuid,credential,e5f6...-uuid,proj1...-uuid,203.0.113.22
2026-07-03T16:40:44.000Z,Alice Chen,project.archived,,,e5f6...-uuid,proj1...-uuid,203.0.113.10
--- Integrity Verification Summary ---
rows_checked,3,passed,3,failed,0,verified_at,2026-07-04T18:32:10.104Z
```

**Edge case — CSV field containing a comma or quote:** **Given** an `actor_display_name` of `Chen, Alice "AC"` (a display name containing both a comma and embedded quotes — a plausible real-world name/nickname), **when** the CSV row is built, **then** the field is rendered as `"Chen, Alice ""AC"""` — quoted, with embedded quotes doubled — verified by a direct unit test of `toCsvRow()` covering comma, quote, `\r`, and `\n` cases independently, plus one plain field requiring no quoting.

---

### AC-13: Export — `actor_display_name` Resolution and Non-Human-Actor Fallback

**Given** an audit row has `actor_type: 'human'` and a valid `actor_token_id`,

**When** the CSV is generated,

**Then** `actor_display_name` is the **current** `user_identity_tokens.display_name` for that token, read live at export time (D-cross-story-context: this means a row exported after Story 8.3's pseudonymization runs shows the pseudonymized alias, not the original name — correct, intentional behavior, not a caching bug).

**Known, explicitly-flagged limitation — cross-org display-name bleed (adversarial-review finding, high; not fixed in this story, flagged for Story 8.3):** `user_identity_tokens` is a **platform-level table, not org-scoped** (`packages/db/src/schema/user-identity-tokens.ts:4`, "Not org-scoped: platform-level identity table shared across orgs"), and a user can belong to multiple orgs (`org_memberships`' `(org_id, user_id)` composite key). Because this AC's "live join" reads `display_name` by `actor_token_id` with no org-scoping on the *name itself*, a `display_name` change triggered by one org (e.g., Story 8.3's pseudonymization firing because Org A processed an erasure/pseudonymization request for a user) will change how that same user's historical audit rows render in **every other org that user belongs to** — not just Org A — the next time any of those orgs runs an export. This is a real side effect on an org that took no action and may not have consented to it, not merely "the requesting org sees the new name." **This story does not change the live-join design** (reverting to a frozen per-row snapshot would be a larger change touching Story 8.1's write path, out of scope here per D1) — instead, this limitation is recorded here and in the Epic Cross-Story Context table below so that **Story 8.3, when it implements pseudonymization, must explicitly decide** whether cross-org display-name bleed is acceptable for its use case or whether it needs an org-scoped display-name mechanism instead of (or in addition to) the platform-level `user_identity_tokens.display_name` field. Do not let Story 8.3 rediscover this as a surprise bug — it is a known, inherited design tension between "one platform identity" and "org-scoped compliance exports," and the decision belongs to whichever story actually implements the name-changing action, not to this read-only export path.

**Edge case — machine/system actor rows (forward-looking, Stories 7.1/7.2 not yet implemented):** **Given** a row has `actor_type: 'machine_user'` or `'system'` (and therefore `actor_token_id: null`, per Story 8.1's D3), **when** exported, **then** `actor_display_name` is the literal string `'machine_user'` or `'system'` respectively — a documented, explicit fallback, not a crash or a blank field. This is a known, accepted limitation (see Epic Cross-Story Context row for 7.1/7.2) that a future story may improve once machine-user audit rows carry a structured identifier.

**Edge case — human actor row with `actor_token_id: null` (should not occur in a clean database per Story 8.1's backfill check, but defensively handled):** `actor_display_name` falls back to the literal string `'unknown'` rather than throwing — the CSV generator must never crash mid-export because of one malformed historical row; it should complete the export and let Story 8.1's backfill-coverage CI guard be the mechanism that catches and prevents such rows from existing in the first place.

---

### AC-14: Export — Range and Format Validation

**Given** an authenticated owner,

**When** they call `POST /audit/export` with any of the following, tested independently:

| Body | Expected response |
|---|---|
| `format: "pdf"` | `422 { code: "validation_error" }` — only `"csv"` is accepted in v1 (AC-E8c) |
| `to` before `from` | `422 { code: "invalid_range" }` |
| Range spanning 401 days (`AUDIT_EXPORT_MAX_RANGE_DAYS = 400`) | `422 { code: "range_too_large" }` |
| Missing `from`/`to` | `422 { code: "validation_error" }` — unlike search (AC-4), export requires an explicit bounded range; an unbounded "export everything" request is rejected rather than silently defaulting, since export is a heavier, storage-consuming operation than a paginated search |

**Then** each case is verified independently, and no job/`audit_exports` row is created for any rejected request.

---

### AC-15: Export Job Status — Polling, Unknown Job, Cross-Org Isolation

**Given** a completed export job belonging to org A,

**When** org A's owner calls `GET /api/v1/org/audit/exports/:jobId`,

**Then** the response is `200`:

```json
{
  "data": {
    "jobId": "f7e8...-uuid",
    "status": "completed",
    "rowsChecked": 1450,
    "integritySummary": { "passed": 1450, "failedCount": 0 },
    "downloadUrl": "/api/v1/org/audit/exports/f7e8...-uuid/download",
    "createdAt": "2026-07-04T18:30:00.000Z",
    "completedAt": "2026-07-04T18:32:11.000Z"
  }
}
```

**Edge case — unknown `jobId`:** a syntactically valid UUID with no matching row returns `404 { code: "export_not_found" }`.

**Edge case — cross-org access attempt:** org B's owner requesting org A's `jobId` also returns `404` (not `403`) — RLS makes the row invisible, and this codebase's convention (matching Story 8.1's credential-import precedent, `import_not_found`) is to return `404` rather than `403` for cross-tenant resource-existence probes, avoiding confirming the resource exists in another tenant.

**Edge case — job still processing:** `status: "processing"`, `downloadUrl: null`, no `integritySummary` yet.

---

### AC-16: Export — Concurrency: Overlapping Export Requests

**Given** an org owner triggers two `POST /audit/export` calls with overlapping (or identical) `[from, to]` ranges in quick succession,

**When** both are processed,

**Then** two independent `audit_exports` rows and two independent pg-boss jobs are created and processed without interfering with each other — each job's verification and CSV generation operates on its own snapshot read, no shared mutable state between concurrent export jobs. **No deduplication/idempotency is required** for this story (epics.md does not ask for it); a compliance officer triggering the same export twice simply gets two jobs and two CSVs — an accepted, documented non-goal, not an oversight.

---

### AC-17: Forwarding Config — Webhook Setup, Happy Path, and SSRF Validation

**Given** an org admin is authenticated,

**When** they call `PUT /api/v1/org/audit/forwarding` with `{ "type": "webhook", "config": { "url": "https://compliance-siem.example.com/ingest", "secretHeader": "wh_sec_9f3ac2..." } }`,

**Then** the response is `200 { "data": { "type": "webhook", "enabled": true, "configuredAt": "2026-07-04T18:40:00.000Z" } }` — the response **never** echoes back `secretHeader` (matches the credential/secret-redaction convention used everywhere else in this codebase, e.g. Story 9.2's SMTP-password `[configured]` pattern cited in epics.md). Internally, `secretHeader` is encrypted via `encryptValue()` (`apps/api/src/lib/encrypt-value.ts`, reused as-is — no new encryption primitive) and stored in `audit_forwarding_config.webhook_secret_encrypted` (jsonb `EncryptedValue`).

**Edge case — SSRF-blocked URL (D4):** **Given** `config.url = "http://169.254.169.254/latest/meta-data/"` (cloud metadata endpoint) or `"https://localhost:8080/internal"` or a hostname that resolves to `10.0.0.5`, **when** the same `PUT` is called, **then** the response is `422 { code: "unsafe_forwarding_url", message: "..." }` — rejected either at Zod-schema level (non-`https://` scheme) or at `assertPublicHostname()`'s DNS-resolution check (private/loopback range), tested independently for: `http://` scheme, loopback (`127.0.0.1`), link-local (`169.254.169.254`), private RFC1918 (`10.0.0.5`, `172.16.0.1`, `192.168.1.1`), and a control case confirming a normal public HTTPS URL is accepted.

**Edge case — DNS-rebinding attempt at delivery time (D4, adversarial-review correction):** **Given** a webhook hostname whose DNS record resolves to a public IP at `PUT`-time validation but is reconfigured (by a malicious or compromised DNS provider) to resolve to `169.254.169.254` before the next delivery attempt, **when** `safeFetchExternal` delivers a row (AC-18), **then** the connection is pinned to the address(es) validated immediately before that specific fetch (via the custom `lookup` override, D4) — the delivery either succeeds against a validated public address or is rejected, and never silently connects to a private/internal address returned by a second, unpinned DNS resolution. Verified with a test double `lookup` that returns different addresses on successive calls, asserting the fetch only ever uses the address that was validated for that call.

**Edge case — webhook target responds with a redirect (D4, adversarial-review correction):** **Given** the configured webhook URL responds with `302 Location: http://169.254.169.254/` (or any other `3xx`), **when** `safeFetchExternal` delivers a row, **then** the redirect is **not followed** (`redirect: 'manual'`) — the `3xx` response is treated as a delivery failure like any other non-`2xx` status, feeding into AC-18's consecutive-failure counter, and no request is ever made to the `Location` target.

**Edge case — S3 `endpoint` SSRF validation (D4, adversarial-review correction):** **Given** `{ "type": "s3", "config": { "endpoint": "http://169.254.169.254/", ... } }` or an `endpoint` hostname resolving to a private RFC1918 address, **when** the same `PUT` is called, **then** the response is `422 { code: "unsafe_forwarding_url" }` — `assertPublicHostname()` validates `config.endpoint` exactly like a webhook `url` before the row is upserted, closing the gap where S3's admin-controlled `endpoint` field would otherwise be the only forwarding-destination input with no SSRF check at all.

**Edge case — switching type from webhook to s3:** a subsequent `PUT` with `{ "type": "s3", "config": {...} }` fully replaces the prior webhook config (the row is upserted, not merged) — `webhook_url`/`webhook_secret_encrypted` become `NULL`, S3 fields populate. Verified by a test asserting the old webhook fields are cleared, not left stale alongside the new S3 config.

---

### AC-18: Forwarding — Webhook Delivery, Timing, and Bounded Failure Handling (D3)

**Given** webhook forwarding is configured and enabled for an org, and 3 new audit rows are written after the last catchup tick,

**When** the `audit:webhook-forward-catchup` cron next runs (every minute),

**Then** each of the 3 rows is POSTed as JSON to the configured URL with header `X-Audit-Webhook-Secret: <decrypted secretHeader>` (decrypted transiently via `withSecret()`, never held in memory longer than the single fetch call), in `created_at, id` order, and `audit_forwarding_config.last_forwarded_created_at`/`last_forwarded_id` advance only after each individual POST returns `2xx` — verified with a mock webhook receiver.

**Edge case — receiver returns 500 for the 2nd of 3 rows:** the 1st row's delivery is confirmed (cursor advances past it), the 2nd row's POST fails and the cursor does **not** advance past it, and the 3rd row is **not attempted this tick** (rows are delivered strictly in order — a job must not skip ahead past a failed row, or a downstream SIEM would see gaps). The next tick retries starting from the 2nd row.

**Edge case — sustained failure (`AUDIT_WEBHOOK_MAX_CONSECUTIVE_FAILURES = 10`):** **Given** the same row fails delivery on 10 consecutive ticks, **when** the 10th failure is recorded, **then** `audit_forwarding_config.enabled` is set to `false`, an operational error is logged (structured, includes org ID and consecutive-failure count), and no further delivery attempts occur until an admin `PUT`s the config again (which resets `consecutive_failure_count` to `0` and re-enables) — verified by a test asserting no 11th delivery attempt occurs and `enabled` flips to `false`.

**And** this route's own successful `PUT` is audited: `eventType: 'audit.forwarding_configured'`, `payload: { type, enabled }` (never the secret).

---

### AC-19: Forwarding — S3 Batch Delivery (Daily, Gzipped JSONL, Minio-Compatible, Watermark Cursor + Bounded Failure)

**Given** S3 forwarding is configured (`{ type: "s3", config: { bucket: "compliance-bucket", prefix: "org-abc/", region: "us-east-1", accessKeyId: "AKIA...", secretAccessKey: "...", endpoint?: "..." } }`) and `s3LastForwardedDate` is `null` (never forwarded before),

**When** the daily `audit:s3-forward-daily` cron runs (e.g. `0 1 * * *`, UTC),

**Then** it forwards **yesterday's** UTC-day rows for that org (the oldest not-yet-forwarded day, since `s3LastForwardedDate IS NULL`), serializes each as one JSON line (JSONL), gzips the batch, and uploads via `@aws-sdk/client-s3`'s `PutObjectCommand` to `s3://compliance-bucket/org-abc/2026-07-03.jsonl.gz` (prefix + ISO date + fixed suffix); `secretAccessKey` is decrypted transiently via `withSecret()` immediately before constructing the S3 client credentials and never logged. **Only after the upload succeeds** does `s3LastForwardedDate` advance to that day.

**Edge case — upload failure, then a later successful catch-up (adversarial-review correction — bounded-failure watermark, high):** **Given** the upload for `2026-07-03` fails (network error, bad credentials, `NoSuchBucket`), **when** the cron runs the *next* day, **then** it retries `2026-07-03` first (not `2026-07-04`) — `s3LastForwardedDate` does not advance past a failed day, and `s3ConsecutiveFailureCount` increments. Verified by a test asserting the same day is re-attempted, not skipped, matching the webhook cursor's "don't skip a failed row" rule (AC-18).

**Edge case — sustained S3 failure (`AUDIT_S3_MAX_CONSECUTIVE_FAILURES = 5`):** **Given** the same day's upload fails on 5 consecutive daily cron runs, **when** the 5th failure is recorded, **then** the org's S3 forwarding config is set to `enabled: false`, a structured operational error is logged (org ID, failed date, consecutive-failure count), and no further upload attempts occur until an admin `PUT`s the config again (resetting `s3ConsecutiveFailureCount` to `0` and re-enabling, resuming from the same unforwarded day, not skipping it) — verified by a test asserting no 6th attempt occurs and `enabled` flips to `false`. This closes the gap where an earlier draft of this story had no S3 failure handling at all and could silently, permanently drop a day of compliance data.

**Edge case — Minio/custom-endpoint config:** **Given** `config.endpoint = "https://minio.internal.example.com:9000"` is additionally supplied (this story's D9 extension beyond epics.md's literal field list), **when** the config is saved via `PUT /audit/forwarding`, **then** `assertPublicHostname()` (D4) validates `endpoint` at configuration time the same way webhook URLs are validated, rejecting private/loopback/link-local targets with `422 { code: "unsafe_forwarding_url" }`; **when** the upload subsequently runs, **then** the S3 client is constructed with `{ endpoint, forcePathStyle: true, region, credentials }` — verified with a mocked S3-compatible test double (e.g. an in-memory mock of the SDK client, not a live Minio instance in CI).

**Edge case — zero rows for the day:** if an org has zero audit rows for the day being forwarded, **no object is uploaded**, but `s3LastForwardedDate` **still advances** past that day (an empty gzip file would be misleading — "we checked, there was nothing" is different from "we forgot to check"; this is logged at debug level, not treated as an error, and not treated as a failure requiring retry).

**And** "write-once" enforcement is explicitly the operator's responsibility via S3 Object Lock configuration on their bucket — the vault documents this requirement (in the route's OpenAPI description and in Dev Notes) but does not and cannot configure bucket-level Object Lock itself (AC-E8b, matches epics.md literally).

---

### AC-20: Forwarding — Encryption at Rest and Never-Returned Secrets

**Given** forwarding config has been set with either a webhook `secretHeader` or S3 `secretAccessKey`,

**When** `GET`-ing the config back is attempted (this story does not implement a `GET /audit/forwarding` per epics.md's literal AC text, which only specifies the `PUT`; **document this explicitly**: there is no read-back endpoint for forwarding config in this story — an admin must track their own configured values, matching how Story 9.2's SMTP-password design intentionally never round-trips a plaintext secret. If a future story adds a `GET`, it must return `{ configured: true }`/redacted shape, never the decrypted secret),

**Then** no code path in this story ever returns a decrypted `secretHeader`/`secretAccessKey` in any HTTP response — verified by a test that greps/asserts the `PUT` response body never contains the plaintext secret submitted in the request, and by the `SecretValue`/`withSecret()` pattern (`@project-vault/crypto`) being the only way plaintext is ever materialized, always zeroed in a `finally` block immediately after use (matching `encryptValue()`'s existing convention in `apps/api/src/lib/encrypt-value.ts`).

---

### AC-21: Forwarding Config — Authorization (Admin-Only) and Required MFA

**Given** an authenticated user with `orgRole: 'member'` or `'viewer'`,

**When** they call `PUT /audit/forwarding` or `PUT /audit/retention`,

**Then** the response is `403 { code: "insufficient_role" }` (`minimumRole: 'admin'`, which admits `owner` too — matching epics.md's literal "(admin only)" wording for both endpoints, `epics.md:1924,1926`).

**And**, given an authenticated admin/owner who has **not** completed MFA enrollment and is past their grace period, calling either endpoint returns `403 MFA_ENROLLMENT_REQUIRED` — both routes set `requireMfa: true`, matching the sensitivity tier of other credential-adjacent mutations (rotation initiation, per Story 8.1's D5 cross-reference), since these endpoints store encrypted external-storage secrets and control where compliance data flows.

---

### AC-22: Retention Config — Set, Validate Bounds, Disable

**Given** an org admin is authenticated,

**When** they call `PUT /api/v1/org/audit/retention` with `{ "retentionDays": 365 }`,

**Then** the response is `200 { "data": { "retentionDays": 365, "updatedAt": "2026-07-04T18:50:00.000Z" } }`, and `audit_retention_config` is upserted (one row per org, `orgId` as primary key).

**Edge case — below floor:** `{ "retentionDays": 10 }` → `422 { code: "validation_error", details: { retentionDays: ["must be >= 30"] } }` (`AUDIT_RETENTION_MIN_DAYS = 30`, D7).

**Edge case — above ceiling:** `{ "retentionDays": 4000 }` → `422` (`AUDIT_RETENTION_MAX_DAYS = 3650`, D7).

**Edge case — explicit "retain forever":** `{ "retentionDays": null }` → `200`, valid, disables automatic pruning for this org (the default state for a new org, D7) — the daily prune job (AC-23) simply skips orgs with `retentionDays: null`.

**And** this route's own successful `PUT` is audited: `eventType: 'audit.retention_configured'`, `payload: { retentionDays }`.

---

### AC-23: Retention — Daily Pruning via the SECURITY DEFINER Escape Hatch (D2)

**Given** org A has `retentionDays: 30` configured and has audit rows both older and newer than 30 days ago; org B has no retention config row at all (never configured — the default),

**When** the `audit:retention-prune` daily cron runs,

**Then** for org A, `purge_expired_audit_log_entries(orgA, now() - interval '30 days')` is called (via the retention worker, never a raw Drizzle `.delete()` against `auditLogEntries`), deleting exactly the rows older than the cutoff and returning the deleted count for logging; org B is skipped entirely (no config row = no pruning, matching D7's "never silently delete data a feature was never configured for" principle).

**And** this is verified with a direct-SQL assertion that attempting the equivalent raw `DELETE FROM audit_log_entries ...` **without** first setting `app.audit_retention_purge` still raises the append-only exception — proving the escape hatch is narrowly scoped to the one sanctioned function, not a general loosening of the trigger (this is the single most important regression test in this story: it proves D2's fix didn't accidentally reopen the append-only guarantee Story 8.1 built).

**Edge case — org-mismatch call to the SECURITY DEFINER function (adversarial-review correction, critical; D2):** **Given** a transaction has its RLS context (`app.current_org_id`) set to Org B (e.g., the retention worker is mid-iteration on Org B), **when** `purge_expired_audit_log_entries(orgA, cutoff)` is called directly with Org A's ID inside that same transaction, **then** the function raises an exception and deletes nothing — verified by a direct test calling the function with a deliberately mismatched `p_org_id` and asserting both the exception and that Org A's row count is unchanged. This is the regression test proving the critical adversarial-review fix: that the function's tenant-isolation guard is not merely documentation but an enforced runtime check, independent of whatever `p_org_id` a caller passes.

**Edge case — concurrent write during pruning:** a new audit row is inserted for org A (`created_at = now()`, well after the cutoff) concurrently with the prune job's `DELETE ... WHERE created_at < cutoff` — the new row is never at risk (its `created_at` doesn't match the `WHERE` clause regardless of transaction timing), verified by a `Promise.all` test asserting the fresh row survives and the count of rows deleted matches exactly the pre-cutoff rows that existed before the concurrent insert.

**Edge case — org with retention configured but zero rows past the cutoff:** the function runs, returns `0` deleted, no error — a no-op prune is a normal, frequent case (most days, for most orgs), not a failure.

---

### AC-24: Migration Safety, RLS Coverage, and Route-Audit CI Coverage

**Given** this story's migration `0030` adds: the `actor_token_id` index (D5), three new tables (`audit_exports`, `audit_forwarding_config`, `audit_retention_config`, all org-scoped with RLS enabled and an isolation policy matching the exact pattern in `0029_machine_users_and_api_keys.sql`), and the `purge_expired_audit_log_entries()` function + trigger amendment (D2),

**When** the story is implemented,

**Then**: (1) no existing column on any existing table is altered or dropped — the only change to `audit_log_entries` is the new index; (2) `check-rls-coverage.ts`'s generic mechanism automatically covers the three new tables (they have `org_id`, are not added to `EXCLUDED_TABLES`) — verified by an explicit named assertion added to `check-rls-coverage.test.ts` for all three new table names, following Story 8.1's AC-9 precedent of never relying on the generic check alone without a named regression test; (3) all six new/modified routes (`GET /audit/events`, `POST /audit/export`, `GET /audit/exports/:jobId`, `GET /audit/exports/:jobId/download`, `PUT /audit/forwarding`, `PUT /audit/retention`) gain `route-exemptions.ts` classifications — five as `action: 'mutation'` (except the two `GET`s, classified `action: 'read'` with an `auditOmissionReason` for the ones that don't write an audit event: the download-stream `GET` and the job-status-polling `GET` — the search `GET` **does** write an audit event per AC-7, so it needs `action: 'mutation'`-shaped classification with `auditEvent: 'audit.search_run'`, not an omission reason) — matching the exact classification-object shapes already used elsewhere in `route-exemptions.ts`.

---

### AC-25: Full Integration Test Matrix

**Given** all ACs above,

**When** the story's test suite runs (`apps/api/src/modules/audit/routes.test.ts` extended with this story's new routes, `apps/api/src/modules/audit/csv.test.ts`, `apps/api/src/modules/audit/forwarding.test.ts`, `apps/api/src/modules/audit/retention.test.ts`, `apps/api/src/workers/audit-retention-prune.test.ts`, `apps/api/src/workers/audit-webhook-forward.test.ts`, `apps/api/src/lib/safe-fetch.test.ts`, plus the `check-rls-coverage.test.ts` addition),

**Then** integration tests cover, at minimum: every numbered edge case in AC-1 through AC-23 above, plus: zero-migration-diff-to-existing-columns assertion (AC-24, repo-inspection style matching Story 8.1's AC-16), the append-only-trigger-still-blocks-unsanctioned-DELETE regression test (AC-23), and route-audit + RLS-coverage CI gate confirmation (AC-24).

---

## Tasks / Subtasks

- [ ] Task 1: Migration `0030` (AC: 24, D2, D5)
  - [ ] 1.1 Add `idx_audit_log_entries_actor_token` index to `audit-log-entries.ts` schema + migration
  - [ ] 1.2 Create `packages/db/src/schema/audit-exports.ts`, `audit-forwarding-config.ts`, `audit-retention-config.ts` — all org-scoped, matching the `orgScoped()` helper and index-naming conventions of `0029_machine_users_and_api_keys.sql`
  - [ ] 1.3 Write migration SQL: three `CREATE TABLE`s + RLS enable + isolation policies (exact pattern from `0029`), `CREATE OR REPLACE FUNCTION purge_expired_audit_log_entries(...)` **including the `app.current_org_id`-vs-`p_org_id` session-context check** (D2's critical fix), `CREATE OR REPLACE FUNCTION prevent_audit_log_mutation()` (amended per D2), `GRANT EXECUTE ... TO vault_app`
  - [ ] 1.4 Add named RLS-coverage assertions in `check-rls-coverage.test.ts` for the three new tables (AC-24)
  - [ ] 1.5 Regression test: raw `DELETE FROM audit_log_entries` without the session flag still raises (AC-23)
  - [ ] 1.6 Regression test: `purge_expired_audit_log_entries()` called with a `p_org_id` that does not match the transaction's `app.current_org_id` raises and deletes nothing (AC-23, D2 critical fix)
- [ ] Task 2: Search endpoint (AC: 1, 2, 3, 4, 5, 6, 7, 8)
  - [ ] 2.1 `apps/api/src/modules/audit/search.ts` — `searchAuditEvents(tx, { orgId, actorId?, eventType?, resourceId?, projectId?, from?, to?, page, limit })`, resolves `actorId` via `user_identity_tokens` (D6) before querying `audit_log_entries`
  - [ ] 2.2 Add `AuditEventsQuerySchema`/`AuditEventsResponseSchema` to `modules/audit/schema.ts`
  - [ ] 2.3 Add `GET /audit/events` to `modules/audit/routes.ts`: `allowedRoles: ['owner']`, `writeAuditEvent: { eventType: 'audit.search_run', ... }`, `rateLimit: { max: 60, timeWindowMs: 60_000 }`, using `resolvePaginationOffset()` with `AUDIT_EVENTS_MAX_OFFSET = 10_000`
  - [ ] 2.4 Seeded-volume `EXPLAIN ANALYZE` perf test (AC-1)
- [ ] Task 3: Export trigger, worker, CSV, download (AC: 9, 10, 11, 12, 13, 14, 15, 16)
  - [ ] 3.1 `apps/api/src/modules/audit/csv.ts` — `toCsvRow()`, unit-tested against comma/quote/`\r`/`\n`/plain cases (D9)
  - [ ] 3.2 `apps/api/src/modules/audit/export.ts` — `runAuditExport(exportId)`: chunked `verifyAuditRange()` calls (≤90-day sub-ranges), aggregate pass/fail, CSV generation with `actor_display_name` resolution + fallback (AC-13), gzip, write to `audit_exports.file_content`
  - [ ] 3.3 `POST /audit/export` route: validation (`AUDIT_EXPORT_MAX_RANGE_DAYS = 400`), `audit_exports` row insert, post-commit `boss.send('audit:export', { exportId })`
  - [ ] 3.4 `GET /audit/exports/:jobId` route: status/summary response, `404` for unknown/cross-org
  - [ ] 3.5 `GET /audit/exports/:jobId/download` route: streams decompressed CSV, correct `Content-Type`/`Content-Disposition`
  - [ ] 3.6 Register `audit:export` worker in `main.ts`
- [ ] Task 4: Webhook forwarding config + SSRF-safe delivery (AC: 17, 18, 20, 21)
  - [ ] 4.1 `apps/api/src/lib/safe-fetch.ts` — `safeFetchExternal()`: HTTPS-only, DNS-resolution private-range rejection, **IP-pinned connection via a custom `lookup` override (closes the DNS-rebinding TOCTOU gap)**, `redirect: 'manual'` (3xx never auto-followed), timeout, bounded response read (D4); also exports `assertPublicHostname(hostnameOrUrl)` (the standalone DNS/private-range check with no fetch, reused by S3 `endpoint` validation in Task 4.3); unit tests for each blocked-range case, the pinned-connection case, and the manual-redirect case
  - [ ] 4.2 `apps/api/src/modules/audit/forwarding.ts` — `configureForwarding()` (upsert, encrypts secrets via `encryptValue()`, calls `assertPublicHostname()` against `config.endpoint` when an S3 config supplies one), `runWebhookForwardCatchup()` (watermark cursor, bounded-failure auto-disable, D3)
  - [ ] 4.3 `PUT /audit/forwarding` route: `minimumRole: 'admin'`, `requireMfa: true`, never echoes secrets; validates both webhook `url` and S3 `endpoint` (when present) via `assertPublicHostname()`
  - [ ] 4.4 Register `audit:webhook-forward-catchup` schedule (`* * * * *`) + worker in `main.ts`
- [ ] Task 5: S3 forwarding (AC: 19)
  - [ ] 5.1 Add `@aws-sdk/client-s3` to `apps/api/package.json`
  - [ ] 5.2 `apps/api/src/modules/audit/s3-forward.ts` — daily batch job with **watermark cursor (`s3LastForwardedDate`) and bounded-failure auto-disable (`s3ConsecutiveFailureCount`, `AUDIT_S3_MAX_CONSECUTIVE_FAILURES = 5`)**, mirroring the webhook catchup's D3 design: query the oldest not-yet-forwarded UTC day, JSONL + gzip, `PutObjectCommand`, Minio-compatible `endpoint`/`forcePathStyle` support
  - [ ] 5.3 Register `audit:s3-forward-daily` schedule (`0 1 * * *`) + worker in `main.ts`
- [ ] Task 6: Retention config + pruning (AC: 22, 23)
  - [ ] 6.1 `apps/api/src/modules/audit/retention.ts` — `configureRetention()` (bounds validation, D7), `apps/api/src/workers/audit-retention-prune.ts` — daily per-org loop calling the SECURITY DEFINER function via `tx.execute(sql\`...\`)`
  - [ ] 6.2 `PUT /audit/retention` route: `minimumRole: 'admin'`, `requireMfa: true`
  - [ ] 6.3 Register `audit:retention-prune` schedule (`0 2 * * *`) + worker in `main.ts`
- [ ] Task 7: Route-exemptions, OpenAPI, full-suite verification (AC: 24, 25)
  - [ ] 7.1 Add all six route classifications to `route-exemptions.ts`
  - [ ] 7.2 Run `pnpm generate-spec`; confirm all new endpoints appear
  - [ ] 7.3 Run `make ci` locally end-to-end

---

## Dev Notes

- **Read D2 before touching anything retention-related.** The append-only trigger + grant revoke Story 8.1 ships is real, already-merged-in-spirit infrastructure; a naive `DELETE` will fail in exactly the way a developer unfamiliar with Story 8.1 would find confusing. The `SECURITY DEFINER` function is the only sanctioned path.
- **Read D3 before touching webhook forwarding.** Do not modify `write-entry.ts`/`human-entry.ts`/`secure-route.ts` — the watermark-cursor catchup cron requires zero changes to Story 8.1's write path.
- Reuse `verifyAuditRange()`, `computeAuditHmac()`, `encryptValue()`, `withSecret()`, `resolvePaginationOffset()`, `PageLimitQueryShape` — this story's biggest risk is reinventing primitives that already exist (same risk category Story 8.1 itself flagged for its own scope).
- `withTestOrg()`'s cleanup does not delete `audit_log_entries` rows (documented no-op, `test-helpers.ts:39-48`) — this remains true for this story's search/export tests; use fresh orgs per test for deterministic counts, same as Story 8.1's Dev Notes.
- The SSRF-safe-fetch utility (`safe-fetch.ts`) is new, general-purpose infrastructure with exactly one consumer in this story (webhook forwarding) — do not over-build its API surface for hypothetical future consumers not yet identified.
- CSV generation is hand-rolled deliberately (D9) — do not add a CSV library dependency for this story.

### Project Structure Notes

- New files: `packages/db/src/schema/audit-exports.ts`, `audit-forwarding-config.ts`, `audit-retention-config.ts`; `packages/db/src/migrations/0030_*.sql`; `apps/api/src/modules/audit/search.ts`, `export.ts`, `csv.ts`, `forwarding.ts`, `s3-forward.ts`, `retention.ts`; `apps/api/src/workers/audit-retention-prune.ts`, `audit-webhook-forward.ts`; `apps/api/src/lib/safe-fetch.ts`; corresponding `*.test.ts` files for each.
- Modified files: `apps/api/src/modules/audit/routes.ts` (add 6 routes to Story 8.1's existing file), `schema.ts` (add corresponding Zod schemas), `packages/db/src/schema/audit-log-entries.ts` (new index only), `apps/api/src/lib/route-exemptions.ts`, `apps/api/src/main.ts` (register 3 new schedules/workers), `apps/api/package.json` (`@aws-sdk/client-s3`), `packages/db/src/__tests__/check-rls-coverage.test.ts`.
- Alignment with unified project structure: matches the existing `modules/<feature>/{routes,schema,*.ts}` convention and `workers/*.ts` + `main.ts` schedule-registration convention (`prune-credential-versions.ts`, `prune-revoked-tokens.ts`).

### References

- [Source: `_bmad-output/planning-artifacts/epics.md#Story-8.2` (lines 1902-1929)] — Story 8.2's literal AC text, and the Epic 8 preamble (PJ4/PJ5, AC-E8b/c) it depends on.
- [Source: `_bmad-output/planning-artifacts/prd.md` lines 921-932] — FR40-FR44, FR69-FR71, FR78 definitions.
- [Source: `_bmad-output/implementation-artifacts/8-1-tamper-evident-audit-log-with-hmac-integrity.md`] — hard prerequisite; source of `verifyAuditRange()`, the append-only trigger/grant this story's migration amends, and the `modules/audit/routes.ts`/`schema.ts` files this story extends.
- [Source: `packages/db/src/schema/audit-log-entries.ts`, `user-identity-tokens.ts`] — existing schema this story reads/extends.
- [Source: `packages/db/src/migrations/0001_rls_and_triggers.sql`, `0002_audit_log_revoke.sql`, `0029_machine_users_and_api_keys.sql`] — patterns this story's migration follows/amends.
- [Source: `apps/api/src/lib/encrypt-value.ts`, `packages/crypto/src/secret-value.ts`] — `encryptValue()`/`withSecret()` reused for forwarding secrets.
- [Source: `apps/api/src/lib/pagination.ts`] — `PageLimitQueryShape`, `resolvePaginationOffset()` reused for search.
- [Source: `apps/api/src/modules/auth/routes.ts:83-93`] — durable-row + catchup-cron delivery pattern this story's webhook forwarding mirrors.
- [Source: `apps/api/src/workers/prune-credential-versions.ts`, `prune-revoked-tokens.ts`] — per-org worker loop pattern retention pruning follows.
- [Source: `_bmad-output/planning-artifacts/ux-design-specification.md` lines 83-86] — Dana persona's compliance-export journey (informs the UI gap noted in Product Surface Contract).
- Product surface rules: [Source: `_bmad-output/implementation-artifacts/product-surface-contract.md`]

---

## Dev Agent Record

### Agent Model Used

{{agent_model_name_version}}

### Debug Log References

### Completion Notes List

### File List
