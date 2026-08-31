# SERVICE_REVOCATION_TOKEN rotation and compromise response (Story 31.1)

<!-- Source: Story 31.1 (DW-130) AC14.48/AC14.49; verified against apps/api/src/config/env.ts,
     apps/api/src/modules/service-provisioning/routes.ts, apps/api/src/modules/service-provisioning/service.ts,
     apps/api/src/modules/auth/session-revoke.ts (revokeAllSessionsForOrg); mirrors
     docs/runbooks/handoff-key-rotation.md's structure (Story 30-2). -->

This runbook covers `SERVICE_REVOCATION_TOKEN`, the static shared secret that authenticates
CentralizeMe (CM) as a machine caller to
`POST /api/v1/service/organizations/:centralizemeOrganizationId/revoke-sessions` — the
machine-authenticated, org-wide session-and-API-key revocation route CM calls when it deprovisions
or deletes an organization (DW-130, closing the gap `docs/runbooks/handoff-key-rotation.md`'s own
compromise-response section flagged as "explicitly out of scope").

## Background

- `SERVICE_REVOCATION_TOKEN` is a **dedicated** secret — never the same value as
  `SERVICE_PROVISIONING_TOKEN` or any other secret in this codebase (production boot enforces
  this: `apps/api/src/config/env.ts`'s `validateServiceRevocationTokenProductionSecret`). A leak of
  one must never compromise the other.
- Unlike `SERVICE_PROVISIONING_TOKEN` (which only creates one new, inert, session-less org per
  call), a leaked `SERVICE_REVOCATION_TOKEN` can silently and repeatedly terminate real, live user
  access — every active session and every active machine-user API key — across **every org on the
  platform**, once per call. Treat a suspected leak as a high-severity incident.
- The route is fail-closed by design: when `SERVICE_REVOCATION_TOKEN` is unset, every request to
  the route gets `403 service_revocation_forbidden` — unconditionally, with no distinction between
  "unset" and "wrong token". This makes **unsetting the env var and restarting the API a
  zero-code, immediate kill switch** (AC14.48) — the first step of the incident procedure below.
- The route is also rate-limited (a coarse, route-wide cap — not per-org, not per-IP) and fires a
  real-time operator alert on every successful call (even at zero revoked). Neither of these
  replaces the kill switch; they exist to bound and surface abuse of a *correct* secret, not to
  substitute for revoking a *leaked* one.

## Routine rotation (5 steps)

1. **Generate a new secret**: `openssl rand -base64 32` (matches the env var's own doc comment in
   `apps/api/src/config/env.ts`). Must be at least 32 characters (`z.string().min(32)`).
2. **Update CM's stored secret first** (CM-side action, outside this repository) — CM's
   deprovisioning job must send the new value on its next call.
3. **Update PV's `SERVICE_REVOCATION_TOKEN` env var and redeploy/restart the API.** Like every
   other env-var-backed secret in this codebase, there is no hot reload — a restart is required for
   the new value to take effect.
4. **Confirm the old value is rejected**: after restart, a request carrying the old token value
   must get `403 service_revocation_forbidden` (verify via an operator smoke test, or by watching
   for a rejected-call spike in operational logs immediately after cutover — an expected, brief
   blip if CM's own rotation lags PV's).
5. **Confirm the new value is accepted**: a request from CM's updated caller with the new token
   must succeed (`200`, with real `sessionsRevokedCount`/`apiKeysRevokedCount` values) and fire the
   operator alert (AC14.46) — confirming the whole path end to end, not just the auth check.

There is no overlap window here (unlike the handoff-key rotation's dual-trusted-key period) — this
is a single static secret, not an asymmetric key pair, so cutover is a single hard swap. A brief
window of CM-caller failures between steps 3 and 4 (if CM's own update lags PV's restart) is
expected and self-resolving once CM picks up the new value from step 2.

## Incident procedure: the alert fired unexpectedly (AC14.46/AC14.48)

A successful call to this route always fires an operator-facing alert (`org.sessions_revoked_by_service`,
delivered via this codebase's existing admin-alert mechanism — see
`apps/api/src/modules/backup/alerts.ts`'s `createAdminAlert`/`deliverAdminAlertAcrossOrgs`, reused
here rather than a new delivery path). A **correct**, CM-triggered call is rare and expected — an
actual org deprovisioning. An operator seeing an **unexpected** one (an org nobody intended to
deprovision, at a time nobody scheduled it, or simply more calls than CM's own operational cadence
would produce) is the fast-detection signal this design relies on to bound a leaked-token blast
radius (Decision 5, Story 31.1).

1. **Freeze the token immediately**: unset `SERVICE_REVOCATION_TOKEN` in PV's environment and
   restart the API. This is the kill switch (AC14.48) — it takes the route offline for every
   caller, including CM's legitimate traffic, until the investigation below is resolved. Prefer a
   short legitimate-traffic outage over continued exposure to a possibly-compromised secret.
2. **Investigate before restoring**:
   - Check the audit trail: every call (successful or not) that reached the handler writes exactly
     one `org.sessions_revoked_by_service` audit row per call
     (`packages/shared/src/constants/audit-events.ts`), even at zero counts — inspect the
     `payload.requestId`/`triggeredBy`/counts fields and the org(s) affected for anything CM itself
     doesn't recognize as its own action.
   - Check operational logs for the coarse rate-limit counter (`rate_limit_exceeded` responses) —
     an unusually high call volume just under the cap is itself a signal of probing.
   - Confirm with CM directly whether the call(s) in question were theirs.
3. **If confirmed a leak**: rotate the secret via the routine-rotation steps above (a fresh
   `openssl rand -base64 32` value, both sides updated) before unfreezing — never simply re-enable
   the same value that may have leaked.
4. **If a false alarm** (e.g. a legitimate but unusually-timed CM deprovisioning): restore the
   existing `SERVICE_REVOCATION_TOKEN` value and restart — no rotation is required.

## Cross-link

See `docs/runbooks/handoff-key-rotation.md` (Story 30-2) for the CM handoff-login signing-key
rotation runbook — a related but structurally different secret (asymmetric key pair with an
overlap window, vs. this route's single static shared secret with a hard-swap kill switch). That
runbook's own compromise-response section names this route (DW-130) as the mechanism that closes
its "no fleet-wide, machine-authenticated revocation" gap.
