# Adversarial Review: Story 6.2 — HTTP Endpoint Monitoring & Availability Alerts

- **Date:** 2026-07-04
- **Reviewed file:** `_bmad-output/implementation-artifacts/6-2-http-endpoint-monitoring-and-availability-alerts.md`
- **Reviewer:** bmad-review-adversarial-general

## Findings

1. **[critical]** AC 4 mandates following redirects with standard `fetch` behavior ("do not disable redirect-following") but nowhere does the story require re-validating each redirect hop's resolved address against the SSRF blocklist. A public URL can 302 to `http://169.254.169.254/latest/meta-data/` or any RFC1918 target and `fetch` will silently follow it, fully defeating the registration-time and check-time SSRF defenses this story is built around. This is the single biggest hole in an otherwise SSRF-conscious design.

2. **[critical]** The described SSRF defense re-resolves DNS at check time (AC 2's DNS-rebinding example, Task 3's `isPrivateOrReservedIp` re-check) but never pins the outbound `fetch()` request to the IP address that was validated. The validation lookup (`dns.promises.lookup`) and the lookup `fetch()` performs internally are two independent resolutions with a time gap between them — a classic DNS-rebinding TOCTOU race that the story's own AC 2 explicitly claims to defend against but the implementation guidance never actually closes (no mention of a custom agent/resolver that forces the HTTP connection to the validated IP).

3. **[critical]** Nothing in AC 1/3/8 caps the number of `service_endpoints` a project or org may register, and the only throttle mentioned is a per-request rate limit on the `POST` route (60/min). A single project `member` can register an effectively unlimited number of endpoints, all pointed at the same third-party (or internal) target URL, and the health-check scheduler will then have the vault's own server infrastructure repeatedly issue outbound HTTP requests to that target every 1–30 minutes forever. This turns the feature into an built-in SSRF-probe / DDoS-amplification tool with no described mitigation.

4. **[high]** ADR-6.2-03 defines `degraded` as exactly `consecutiveFailures = 1` and `down` as `consecutiveFailures ≥ downThresholdFailures`, but when `downThresholdFailures > 2` (allowed range is 1–10), there is no defined status for `consecutiveFailures` values strictly between 1 and `downThresholdFailures - 1` (e.g. `consecutiveFailures = 3` with `downThresholdFailures = 5`). The `service_endpoints.status` CHECK constraint only allows `healthy`/`degraded`/`down`, so this is an actual logic gap in the spec, not just an omission — the dev agent has no source of truth for what status to assign in that range.

5. **[high]** The anomalous-access worker (Task 7) is explicitly told to dedup via `pg_advisory_xact_lock` (mirroring `check-failed-auth-threshold.ts`), but the health-check worker's episode-key dedup (ADR-6.2-05, Task 6) only describes a "check for an existing `monitoring_alerts` row with the same `episodeKey`" — a plain check-then-insert with no advisory lock or equivalent atomicity guarantee. Combined with the finding below about possible overlapping scheduler ticks, this is a real race condition that can produce duplicate `service.down` alerts/notifications for the same episode.

6. **[high]** AC 8's scheduler runs every 60 seconds and Task 6 describes processing each due endpoint sequentially ("wrap each endpoint's check... in its own... transaction inside a per-row try/catch") with a 10-second-per-check timeout. Nothing addresses what happens if the number of due endpoints in a single tick is large enough that sequential processing exceeds 60 seconds (e.g., a batch of slow/hanging endpoints), which would cause the next scheduled tick to start before the previous one finishes. There is no mention of a concurrency limit, batching strategy, or an overlap guard for the job itself — a genuine scalability and correctness risk the story's own "load/perf note" (AC 8) claims awareness of but doesn't actually address for this failure mode.

7. **[high]** Task 3's exhaustive boundary list for `isPrivateOrReservedIp` omits IPv4-mapped IPv6 addresses (e.g. `::ffff:127.0.0.1`, `::ffff:169.254.169.254`) and alternate IP-literal encodings (decimal/octal/hex forms like `http://2130706433/` for `127.0.0.1`) — both are well-known SSRF filter bypass techniques and neither is mentioned anywhere in the SSRF validation task or its test plan.

8. **[high]** AC 9 and AC 10 assume the caller already possesses a `monitoring_alerts.id` (`:alertId`) to call snooze/dismiss, but no AC or task in this story defines a `GET .../alerts` (or similar) list/discovery endpoint, nor explicitly states that the `alertId` is included in the notification payload delivered to the user (email/Slack/inbox). Without one of these, the persona-journey claim ("a developer can snooze a noisy alert... via `POST .../alerts/:alertId/snooze`") is not actually achievable by an end user — there's no described way to obtain the id.

9. **[high]** The `anomalousAccessPayloadSchema` (Task 1) only captures `{ actorTokenId, revealedCount, windowSeconds, windowStart, windowEnd }` — it never records which credentials or resources were revealed. An org admin receiving a `security.anomalous_access` alert learns "user X revealed N credentials in the last hour" but has no way to know *which* credentials, severely limiting the alert's usefulness for actual incident response despite this being a security-investigation feature.

10. **[high]** Any project `member`+ can permanently `dismiss` a `service.down` alert (AC 10) with no elevated-role requirement and no notification to org admins that the alert was silenced (only an audit-log entry, which nobody is proactively watching). A low-privileged or compromised member account can unilaterally suppress a critical availability alert that org admins would otherwise have been paged for, with no compensating control described.

11. **[high]** `service_endpoints.url` and the audit-log payload snapshots for `SERVICE_ENDPOINT_CREATED`/`UPDATED`/`DELETED` (AC 14) store and echo the URL verbatim, including any userinfo component (`user:pass@host`) or secret-bearing query parameters (e.g. `?apikey=...`) a user might configure for a health-check endpoint. There is no mention anywhere of redacting/masking credential-like URL components before persisting or audit-logging them — a secrets-handling gap that is especially notable in a product whose core purpose is protecting secrets.

12. **[medium]** Task 6 describes the scheduler's due-query as querying "all `service_endpoints` rows across all orgs" in what reads as a single global query, while AC 13 requires RLS enforcement via `org_id = current_setting('app.current_org_id')`. A single query spanning all orgs is fundamentally in tension with per-session RLS scoping unless the worker uses a per-org loop (`fetchAllOrgIds` + `runOrgScopedJob`, as referenced elsewhere in Dev Notes) or an RLS-bypassing service connection — the story never clarifies which, leaving an important cross-cutting security mechanism's interaction with the new scheduler unspecified.

13. **[medium]** Per AC 2's DNS-rebinding example, a check blocked for SSRF reasons is logged only server-side (`MONITORING_HEALTH_CHECK_SSRF_BLOCKED`) and explicitly must **not** get a new public-facing column ("do not over-engineer the schema for it"). This means a legitimate endpoint whose DNS starts resolving privately (e.g., due to an infrastructure change) looks identical to ordinary downtime to any API consumer — there is no way to distinguish "genuinely down" from "SSRF-blocked" without server log access, undermining the alert's diagnostic value for exactly the edge case the story spent an entire ADR designing for.

14. **[medium]** Alert-lifecycle terminal-state handling is inconsistent: dismissing an already-dismissed alert is a `200` idempotent no-op (AC 10), but snoozing an already-dismissed alert is a `409` conflict (AC 9). The equally plausible cases of re-snoozing an already-snoozed alert (does it extend `snoozedUntil` or error?) and dismissing an already-snoozed alert are never addressed at all.

15. **[medium]** `security.anomalous_access` alerts are fixed at `severity: 'warning'` (AC 11), strictly lower than `service.down`'s `severity: 'critical'` — yet an anomalous-access alert is a potential signal of active credential compromise or insider threat, arguably at least as urgent as a downed HTTP endpoint. The severity assignment is asserted without justification and looks under-prioritized relative to the product's stated threat model.

16. **[medium]** The health-check scheduler gets an explicit new index (`checkFrequencyMinutes, lastCheckedAt`) to keep its every-60-second due-query cheap (AC 8), but the anomalous-access job's every-60-second windowed `GROUP BY (org_id, actor_token_id)` query against `audit_log_entries` (Task 7) gets no corresponding index called out anywhere, despite `audit_log_entries` being a table that grows continuously and unboundedly. This is the same class of "missing index on a query that runs forever" issue AC 8 explicitly warns about — just left unaddressed for the other new worker.

17. **[medium]** `ANOMALOUS_ACCESS_WINDOW_SECONDS` is bounded `min(60).max(3600).default(3600)` — the maximum is hardcoded to equal the default, so the env var can only ever be narrowed, never widened, despite ADR-6.2-06 framing it as mirroring the fully-tunable `FAILED_AUTH_THRESHOLD_*` pattern. The "configurability" this ADR claims to provide is illusory in the direction that would matter most for an org wanting a longer detection window.

18. **[medium]** Task 2 explicitly flags that migration number `0029` may already be claimed by concurrently in-flight Stories 5.2/5.3 ("verify at implementation time") — this is a known, acknowledged merge-collision risk with no actual coordination mechanism proposed beyond "check again later," leaving a real integration/delivery risk unresolved at spec time.

19. **[medium]** Beyond the per-request `POST` rate limit, there is no described cap on total registered endpoints, no egress-connection concurrency limit, and no circuit breaker for endpoints that behave like a slow-loris target (holding connections open near the 10-second timeout repeatedly). Combined with finding 3 and finding 6, this leaves the worker's resource consumption effectively unbounded under adversarial or merely careless use.

20. **[medium]** No AC or task specifies that the `service.down`/`service.recovery`/`security.anomalous_access` notification payloads actually include the corresponding `monitoring_alerts.id`/`security_alerts.id`. Without the id reaching the recipient through the notification itself, the snooze/dismiss endpoints described in AC 9/10 have no described path for a real user to invoke them (see also finding 8).

21. **[low]** `HealthHistoryQuerySchema` (Task 4) never specifies a default value for `limit` when the query parameter is omitted — only the upper cap (200) is given in AC 7.

22. **[low]** AC 16's test list, thorough as it is, does not include a test for the redirect-to-private-IP SSRF bypass (finding 1), the overlapping-scheduler-tick race (finding 6), or the undefined-status gap for `consecutiveFailures` strictly between 1 and `downThresholdFailures` (finding 4) — the test plan inherits the same blind spots as the AC it was derived from.

23. **[low]** The `downEpisodeStartedAt` column added to `service_endpoints` (Task 2) is never mentioned as part of any GET/list response shape in AC 1, 3, or elsewhere — it's unclear whether this is purely internal bookkeeping or intended to be part of the public API contract.

24. **[low]** The Known Scope Boundary explicitly leaves `security_alerts` dismiss/snooze routes unbuilt even though this story implements the exact dismiss/snooze machinery pattern needed and the target table has had unused `dismissedBy`/`dismissedAt`/`dismissalReason` columns sitting idle since Story 3.4. Wiring even a bare dismiss route would have been a comparatively small incremental addition; deferring it again grows accumulated tech debt on a security-relevant surface for a second story in a row.

## Resolution Log

**Date:** 2026-07-04 (same session, after initial review). All 24 findings below were resolved by revising the story file directly — this review file is left unmodified as the historical record of the first-draft review; the story file itself now reflects the fixes.

| # | Severity | Resolution | Where in the story |
|---|---|---|---|
| 1 | critical | Redirect hops re-validated against the SSRF blocklist before being followed; bounded to 5 hops | ADR-6.2-08, AC 4, Task 6 |
| 2 | critical | Outbound connection pinned to the DNS-validated IP via a custom `undici.Agent` (`createSsrfSafeDispatcher`), closing the TOCTOU gap | ADR-6.2-08, AC 2/4, Task 3/6 |
| 3 | critical | Per-project endpoint registration cap (`MAX_SERVICE_ENDPOINTS_PER_PROJECT`, default 25) | ADR-6.2-09, AC 1, Task 4/6 |
| 4 | high | `degraded` redefined as the half-open range `1 ≤ consecutiveFailures < downThresholdFailures` | ADR-6.2-03 (amended), AC 16, Task 6 |
| 5 | high | Episode-dedup check-then-insert wrapped in `pg_advisory_xact_lock` | ADR-6.2-05 (amended), AC 5, Task 6 |
| 6 | high | Non-blocking `pg_advisory_lock` overlap guard + bounded per-tick concurrency (`HEALTH_CHECK_MAX_CONCURRENCY`) | ADR-6.2-09, AC 8, Task 6 |
| 7 | high | IPv4-mapped IPv6 and decimal/hex/octal IP-literal encodings normalized and rejected | ADR-6.2-08, AC 2, Task 3 |
| 8 | high | New `GET /:projectId/alerts` discovery endpoint | ADR-6.2-10, AC 17, Task 4/5 |
| 9 | high | `anomalousAccessPayloadSchema` gains `revealedCredentialIds` (capped at 50) | ADR-6.2-06 (amended), AC 11, Task 1/7 |
| 10 | high | Monitoring-alert and security-alert dismiss routes restricted to `admin`+ role | AC 10/18, Task 5 |
| 11 | high | `redactUrlForDisplay` strips userinfo/secret-shaped query params before persistence-adjacent surfaces echo the URL | ADR-6.2-11, AC 1/14, Task 3/4 |
| 12 | medium | Clarified the scheduler uses a per-org `fetchAllOrgIds` + `runOrgScopedJob` loop, never a single cross-org query bypassing RLS | ADR-6.2-09 (RLS clarification), Task 6 |
| 13 | medium | New `failureReason` diagnostic column on `endpoint_health_checks`, exposed in health-history | ADR-6.2-12, AC 4/7, Task 2 |
| 14 | medium | Re-snooze extends `snoozedUntil`; dismiss-while-snoozed transitions to `dismissed` | AC 9/10 |
| 15 | medium | Anomalous-access alert severity raised to `critical` | ADR-6.2-06 (amended), AC 11, Task 7 |
| 16 | medium | Index added for `audit_log_entries (org_id, actor_token_id, event_type, created_at)` if missing | ADR-6.2-06 (amended), Task 2 |
| 17 | medium | `ANOMALOUS_ACCESS_WINDOW_SECONDS` max raised from `3600` (equal to default) to `86400` | ADR-6.2-06 (amended), Task 7 |
| 18 | medium | Added an explicit pre-merge re-verification step for the migration number, beyond the original one-time check | Task 2 |
| 19 | medium | Resolved by the combination of findings 3 and 6's fixes (bounded endpoint count × bounded per-check timeout × bounded concurrency); no separate circuit-breaker added (documented as a deliberate v1 scope decision) | ADR-6.2-09, Known Scope Boundary |
| 20 | medium | Notification template context now includes the firing `monitoring_alerts.id`/`security_alerts.id` | ADR-6.2-10, AC 5/6/11, Task 6/7 |
| 21 | low | `HealthHistoryQuerySchema.limit` now defaults to `50` | AC 7, Task 4 |
| 22 | low | AC 16's test list extended to cover redirect-SSRF bypass, overlap-guard skip, and the corrected `degraded` range, plus every other new/changed behavior | AC 16, Task 9 |
| 23 | low | Explicitly documented `downEpisodeStartedAt` as internal-only, excluded from every response schema | AC 1, Task 2/4 |
| 24 | low | Added a bare, org-admin-only `POST /organizations/:orgId/security-alerts/:securityAlertId/dismiss` route (snooze intentionally still out of scope) | ADR-6.2-04 (amended), AC 18, Task 1/4/5/9 |

**Outcome: 24/24 findings resolved (3 critical, 8 high, 10 medium, 3 low).** No findings were dismissed or deferred as out-of-scope except where explicitly noted (finding 19's circuit-breaker decision, finding 24's snooze-for-security_alerts decision) — both are documented trade-offs in the story's Known Scope Boundary, not silently dropped gaps.
