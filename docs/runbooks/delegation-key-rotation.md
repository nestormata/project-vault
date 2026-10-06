# Delegation key rotation, alert triage and compromise response

<!-- Verified against apps/api/src/config/delegation-verify-keys.ts, apps/api/src/config/env.ts,
     apps/api/src/modules/auth/delegation-verify.ts, apps/api/src/lib/delegation-stages.ts,
     apps/api/src/modules/auth/delegation-replay-store.ts,
     apps/api/src/modules/auth/delegation-security-events.ts,
     apps/api/src/modules/auth/delegation-metrics.ts,
     apps/api/src/workers/prune-delegation-assertion-jti.ts,
     packages/db/src/schema/{platform-security-events,audit-log-entries}.ts,
     docs/runbooks/alerts/delegation-alerts.rules.yml -->

## When to use

Everything an operator does about `VAULT_DELEGATION_VERIFY_KEYS` and the service-delegated actor
assertions a CentralizeMe-style sender presents to extension routes that declare `delegation`:

- a routine, planned key rotation;
- an emergency revoke after a suspected compromise;
- a delegation alert fired (see [Alert triage](#alert-triage));
- delegated writes are failing and you need to know why (replay store, org not linked, clock drift).

See [`handoff-instance-identity.md`](handoff-instance-identity.md) for the instance identity
(`VAULT_HANDOFF_INSTANCE_ID`) the assertion audience is built from, and
[`monitoring.md`](monitoring.md) for scraping `/metrics`. This runbook assumes both are in place.

The login handoff has its own key set and its own runbook,
[`handoff-key-rotation.md`](handoff-key-rotation.md). The two are separate on purpose: do not copy
steps or timings between them (the 120-second figure there belongs to a different token).

## Ownership

**Key generation and rotation are maintainer-only.** An operator who is not the maintainer does not
generate, rotate or revoke a delegation key: they escalate to the maintainer. Deploying a key that the
maintainer has already supplied is the only key operation an operator performs, and only inside the
steps below.

## Background: why this is a restart-required, exact-kid operation

- `VAULT_DELEGATION_VERIFY_KEYS` (`delegationVerifyKeys` in `apps/api/src/config/env.ts`) is parsed
  **once, at boot**. Adding OR removing a key never takes effect on a running process. **Every instance
  must be restarted after any change.** There is no hot reload and no live revocation list in v1.
- The verifier selects a key by **exact `kid` match** only; it never tries every configured key. An
  assertion whose `kid` is not configured on an instance is rejected `unknown_kid` there, even during an
  overlap window.
- The set is **separate from the handoff set**. Boot fails if a `kid`, or the key material itself,
  also appears in `VAULT_HANDOFF_VERIFY_KEYS`, if an entry is not an Ed25519 public key in exactly one
  PEM block, or if the set is non-empty while `VAULT_HANDOFF_INSTANCE_ID` is unset (the assertion
  audience is `pvd:<instance id>`).
- **No keys configured is a safe state, not an error:** every delegated route answers the generic
  `401 delegation_invalid` and every other route is unchanged (outcome `not_configured`).
- **Key custody is the sender's.** The private key lives in the sender's (CentralizeMe's) secret
  manager. It is never in this repository, never on an operator laptop and never printed. This
  application only ever holds public keys.
- "Instance" here means one Project Vault deployment (one API process; a single API replica is the only
  supported topology, see [`multi-replica.md`](multi-replica.md)). A deployment with several instances
  (one per tenant, or a fleet) must apply every step to **each** of them.
- An assertion creates **no session**: there is no `sessions` row, cookie or refresh token to revoke.
  The handoff runbook's session-revoke steps do not apply to a delegation key compromise.

Key id convention: `cm-deleg-<yyyy-mm>[-n]`. The examples below use obviously fake ids.

## Prerequisites checklist

Before delegated writes are expected to work on an instance:

- [ ] `VAULT_HANDOFF_INSTANCE_ID` is set (the audience is `pvd:<that id>`).
- [ ] `VAULT_DELEGATION_VERIFY_KEYS` holds at least one Ed25519 public key and the instance booted
      without a `VAULT_DELEGATION_VERIFY_KEYS` `FATAL:` line.
- [ ] **Every organization that receives delegated writes carries a `centralizeme_organization_id`.** A
      missing value shows as `421 delegation_org_not_served` and the `org_not_served` counter outcome.
      To find organizations that are not linked (run with a database role that can read `organizations`):

  ```sql
  SELECT id, name, slug
  FROM organizations
  WHERE centralizeme_organization_id IS NULL;
  ```

- [ ] The delegation alert rules are loaded into your Prometheus
      ([`alerts/delegation-alerts.rules.yml`](alerts/delegation-alerts.rules.yml)) and `/metrics` is
      scraped from every instance ([`monitoring.md`](monitoring.md)).

## Routine key rotation (6 steps)

Follow this exact order. Skipping or reordering a step causes either a delegated-write outage or an
unintended widening of trust.

1. **Generate (maintainer, in the sender's custody).** A new Ed25519 keypair with a new `kid`, for
   example `cm-deleg-2026-02`. The private key stays in the sender's secret manager.
2. **Add the new public key next to the old one on every instance, and restart every instance.**

   ```json
   [
     { "kid": "cm-deleg-2026-01", "publicKeyPem": "-----BEGIN PUBLIC KEY-----\n...(old)...\n-----END PUBLIC KEY-----" },
     { "kid": "cm-deleg-2026-02", "publicKeyPem": "-----BEGIN PUBLIC KEY-----\n...(new)...\n-----END PUBLIC KEY-----" }
   ]
   ```

   A restart seals the vault: complete the manual unseal on **every restarted instance**
   ([`vault-lifecycle.md`](vault-lifecycle.md) § Manual unseal after an unexpected seal). A sealed
   instance serves no delegated writes.
3. **Verify that every instance loaded both keys, before the sender signs with the new one.** What
   exists today: each instance's boot log shows no `VAULT_DELEGATION_VERIFY_KEYS` `FATAL:` line, and
   the sender can present a synthetic (test-org) assertion signed with the new key against **each**
   instance and see it admitted. Nothing in this repository mints a synthetic delegation assertion and
   no endpoint lists the configured `kid` values, so the end-to-end proof is the sender-side synthetic
   call. Do not skip it: **removal in step 6 must wait for EVERY instance to have the new kid before
   the switch**, because an instance missing it answers `unknown_kid` to the new signer while its
   siblings accept it, an inconsistent partial outage.
4. **The sender switches to signing with the new kid.** Both keys stay configured on every instance
   (the overlap window); assertions signed by either verify.
5. **Wait at least 5 minutes** (derivation below), then continue.
6. **Remove the old kid from every instance and restart every instance** (and unseal each).

### Why 5 minutes (derived, not asserted)

An assertion lives at most 60 s (`exp - iat <= 60`, enforced by the verifier). The verifier accepts it
until `exp` plus a 30 s clock-skew tolerance, so the latest moment any assertion can still verify is
`iat + 60 s + 30 s = 90 s`. The sender mints one assertion per request, immediately before sending and
never ahead of time, so the last assertion signed with the old key is minted at the moment of the
switch (step 4). 90 s after that nothing signed with the old key can verify. The remaining margin is
deployment propagation (a switch that has not reached every sender replica, a queued retry that mints
late). Five minutes covers the 90 s plus that propagation margin. The 120 seconds in
[`handoff-key-rotation.md`](handoff-key-rotation.md) is the acceptance window of a different token and
must not be used here.

### Overlap-window correctness

During the overlap both keys verify, each by its own `kid`. An assertion signed with a key that is not
configured on an instance, or with a `kid` that is configured but a mismatching key, is rejected there
(`unknown_kid` for an unconfigured id, `signature_invalid` for a wrong key) and never falls back to the
other key. A `kid` is trusted only after its signature verified: no unauthenticated caller can select a
rate-limit bucket or a metric label value.

### Rollback

Re-add the old key to every instance's array and restart (and unseal) every instance. Because
selection is by exact `kid`, restoring the old entry restores acceptance of old-key assertions without
affecting new-key assertions. Use this only to recover from a botched rotation, never after a
compromise.

## Emergency revoke and compromise response

### Honest limits (read before acting)

- **Revoke = remove the kid from `VAULT_DELEGATION_VERIFY_KEYS` and restart.** It is **not
  instantaneous and not atomic across instances**: each instance flips when it restarts.
- There is **no live revocation list in v1**. Until an instance restarts it keeps accepting assertions
  signed by the revoked key.
- What bounds the gap: an assertion lives at most about 60 s (90 s with skew) and is single-use per
  organization (the replay store burns its `jti`). A captured assertion cannot be reused after it was
  burned, and cannot be reused at all after about 90 s.
- A forged assertion needs the private key. If the key leaked, an attacker can mint fresh assertions
  until every instance has restarted without the kid. Restart the highest-value instances first.
- **Per-organization stop without a restart:** the route's `security.capability` gate (the per-org kill
  switch) still runs against the resolved organization on a delegated route. Turning the capability off
  for an organization stops delegated writes for that organization immediately, with no restart.
- A restart seals the vault. Complete the manual unseal on every restarted instance
  ([`vault-lifecycle.md`](vault-lifecycle.md)).
- Revoking sessions is **not applicable**: an assertion creates no session. Do not run the handoff
  runbook's session-revoke steps for a delegation key.

### Steps

1. Confirm with the maintainer that the key is compromised (a leak of the private key, or a forged
   signature you can prove). Do not rotate on your own authority.
2. If delegated writes must stop at once for an organization, disable the route capability for it
   (above).
3. The maintainer supplies a replacement `kid` and public key. Deploy the replacement and remove the
   compromised `kid` in **one** change to every instance's `VAULT_DELEGATION_VERIFY_KEYS`, restart and
   unseal each instance (there is no overlap window: the sender must already be signing with the
   replacement, or delegated writes pause until it does).
4. Track which instances have restarted: until the last one has, the compromised key still verifies
   there.
5. Triage what happened (below) and report to the maintainer.

### Compromise triage with the new signals

Alerts that point at a forged or stolen key: `PvDelegationSignatureInvalidSpike`,
`PvDelegationUnknownKidSpike` and `PvDelegationReplayed` (see [Alert triage](#alert-triage)). They are
counter-based on purpose: while the database is down the security-event write fails too, so the counter
is the only signal.

**Rejected assertions** are `platform_security_events` rows of type `delegation_assertion_rejected`.
The payload carries only a closed set of fields: `reason` (the counter outcome), `routeKey`, `status`,
`orgId` (the resolved Project Vault organization id, when known), `kid` (a configured key id),
`jtiHash` (first 16 hex characters of a SHA-256 of the assertion id: never the assertion id itself),
`requestId` and, for `store_unavailable`, `storeFailure`. There is no raw assertion, header, actor
subject or request body in a row. A pre-signature failure (`unknown_kid`, `signature_invalid`,
`malformed`, `unexpected_alg`, `oversized`, `not_configured`, `missing`) writes **no row** by design
(an unauthenticated caller must not be able to grow a table): the counter is the only signal for those.
A row is written only for an assertion whose signature verified against a configured key, and the
write is bounded by a per-`kid` limiter, so the absence of a row during a flood is expected.

```sql
-- Rejections of the last hour, by reason and key id
SELECT payload->>'reason' AS reason, payload->>'kid' AS kid, count(*) AS rejections
FROM platform_security_events
WHERE event_type = 'delegation_assertion_rejected'
  AND created_at > now() - interval '1 hour'
GROUP BY 1, 2
ORDER BY rejections DESC;

-- Everything one key id was rejected for, for one organization
SELECT created_at, payload->>'reason' AS reason, payload->>'routeKey' AS route_key,
       payload->>'status' AS status, payload->>'requestId' AS request_id, ip_address
FROM platform_security_events
WHERE event_type = 'delegation_assertion_rejected'
  AND payload->>'kid' = 'cm-deleg-2026-01'
  AND payload->>'orgId' = '<project vault organization uuid>'
ORDER BY created_at DESC
LIMIT 200;

-- Join a structured log line to its row: the log line's reqId equals the row's requestId
SELECT created_at, payload
FROM platform_security_events
WHERE event_type = 'delegation_assertion_rejected'
  AND payload->>'requestId' = '<reqId from the log line>';
```

`platform_security_events` has no row-level security and no organization column (the organization id is
inside the payload). It is read by an operator with database access only: no API route exposes it.
Rejections are **never** written to an organization's `audit_log_entries`.

**An accepted-but-forged write** is an audit row, not a security event: the host stores `pvAttribution`
in the row's payload (under the audit HMAC), with `delegatedBy` (`kid`, `issuer`, `assertionId`) and an
`actor` whose `attestation` is `pv_verified` or `issuer_attested`. A forged assertion for an unlinked or
historical actor is `issuer_attested`. To enumerate what a key wrote in a window, run the query inside
the organization's context (`audit_log_entries` is row-level-security protected: a transaction that sets
`app.current_org_id` first, or an operator role that bypasses it):

```sql
BEGIN;
SELECT set_config('app.current_org_id', '<project vault organization uuid>', true);
SELECT id, event_type, created_at,
       payload->'pvAttribution'->'delegatedBy'->>'assertionId' AS assertion_id,
       payload->'pvAttribution'->'actor'->>'attestation' AS attestation,
       payload->'pvAttribution'->'actor'->>'subject' AS actor_subject
FROM audit_log_entries
WHERE payload->'pvAttribution'->'delegatedBy'->>'kid' = 'cm-deleg-2026-01'
  AND created_at BETWEEN '<window start>' AND '<window end>'
ORDER BY created_at;
COMMIT;
```

Treat every row written by the compromised `kid` after the suspected leak as untrusted and review it
with the organization's admins. The assertion ids join to the sender's own logs.

## Alert triage

The shipped rules are in [`alerts/delegation-alerts.rules.yml`](alerts/delegation-alerts.rules.yml). Load
the file into your own Prometheus and route the `severity` labels in your own Alertmanager: alert
delivery is operator-owned, PV adds no alerting worker. The source is the counter
`pv_delegation_assertions_total{outcome,kid}` (see [`monitoring.md`](monitoring.md)). It is
**per process**: take every sum across all scrape targets (`sum(...)`, as the rules do), see
[`multi-replica.md`](multi-replica.md). The thresholds are starting values: tune per deployment.

| Alert | Severity | Who is paged |
| --- | --- | --- |
| `PvDelegationStoreUnavailable`, `PvDelegationKeyConfigMissing` | critical | page the on-call operator: delegated writes are paused or failing closed |
| `PvDelegationSignatureInvalidSpike`, `PvDelegationUnknownKidSpike`, `PvDelegationReplayed`, `PvDelegationClockSkew`, `PvDelegationRejectionRatioHigh` | warning | ticket, same-business-day triage; escalate to the maintainer if more than one security alert fires together |

Counter outcomes that move without any alert (`missing`, `rate_limited_pre`, `malformed`, ...) are
attacker-controlled without a key and are deliberately excluded from the ratio alert.

### PvDelegationSignatureInvalidSpike

More than 5 assertions in 5 minutes carried a `kid` this instance trusts but a signature that did not
verify. Pre-signature failures write no security-event row, so the counter is the signal: read it per
instance to see which one is probed, and check the sender's logs. A wrong key deployed on the sender, a half-finished rotation, or a probe by someone who knows a
`kid`. If it coincides with `PvDelegationReplayed` or you cannot explain it, treat it as a possible
compromise and escalate to the maintainer ([Emergency revoke](#emergency-revoke-and-compromise-response)).

### PvDelegationUnknownKidSpike

More than 5 assertions in 5 minutes named a `kid` that is not configured here. Most often a sender
signing with a new key before every instance has it (a rotation step 3 miss: add the key to the instance
that answers `unknown_kid` and restart it), a stale signer after a removal, or a probe. The counter's
`kid` label is `none` for these: an unknown id is never turned into a label.

### PvDelegationReplayed

An assertion was presented twice (`409 delegation_replayed`). Replays are never legitimate: the sender
mints a new assertion per attempt. A sender retry bug mints the same assertion twice; a captured
assertion replayed is the hostile case. Query the rows for `reason = 'replayed'` (`orgId`, `kid`,
`jtiHash`) and ask the sender to look the `jtiHash` up. Because the burn is shared and durable, the
second presentation is always refused, so the damage of a replay is a failed request, not a second
write.

### PvDelegationStoreUnavailable

The replay store could not record the burn (`503 delegation_replay_store_unavailable`, `Retry-After:
2`), so **delegated writes are paused** (fail closed). Every other route is unaffected. Severity
critical after 2 minutes.

- **Diagnose:** Postgres reachability from the API, connection-pool saturation
  (`db_pool_connections_active`), and the cause recorded on the row/log line as `storeFailure`:
  `sqlstate:<code>` (for example `sqlstate:57P03`, cannot connect now, a database that is starting or
  in recovery), `driver_error` (a socket-level failure with no SQLSTATE, such as a reset connection) or
  `timeout` (the 3 s request deadline fired). The metric never carries the code as a label; read it from
  the `delegation.store_unavailable` log line or the security event.
- **What the sender does:** it mints a **new** assertion for every attempt (the burned or unburned
  assertion is never resent) and the `idempotencyKey` of the audit write keeps the write idempotent, so
  a retry after recovery cannot double-write.
- **Fix:** restore the database or the pool; nothing in this runbook changes. There is no in-process
  fallback by design.
- **Clock note:** the prune worker deletes burn rows by `expires_at` with a 300 s grace, and a row
  lives until `exp + 30 s`. API instances' clocks should agree within seconds: an instance whose clock
  runs more than about 300 s **ahead** of another could prune a burn row the other instance still
  considers live. The `clock_skew.measured` signal in
  [`handoff-instance-identity.md`](handoff-instance-identity.md) § Clock-skew magnitude signal is the
  early warning; fix the clock before anything else when it warns.

### PvDelegationClockSkew

More than 3 assertions in 10 minutes were rejected for time (`expired`, `clock_skew`, `not_yet_valid`).
Either the sender's clock drifted, or this instance's did. First response: check
`clock_skew.measured` on this instance
([`handoff-instance-identity.md`](handoff-instance-identity.md) § Clock-skew magnitude signal) and ask
the sender to check theirs. The verifier tolerates 30 s; the sender retries an expired or not-yet-valid
assertion once with a fresh one and should alert rather than loop.

### PvDelegationRejectionRatioHigh

More than 20 % of the assertions that passed the signature check (at least 20 of them in 10 minutes)
were rejected after it, for 10 minutes. The ratio counts only post-signature outcomes, over `accepted`
plus those same outcomes, so an attacker without a key can neither trigger nor dilute it. Group the
rejections by `reason` (query above) to see which: `org_not_served` (an unlinked organization, see the
[prerequisites](#prerequisites-checklist)), `actor_not_member`, `operation_mismatch` or `body_mismatch`
(sender bugs), `replayed`, `store_unavailable`. `accepted` means "admitted by the delegation stages",
**not** that the request succeeded: a handler 5xx after admission is still `accepted`, so this is not an
end-to-end success rate.

### PvDelegationKeyConfigMissing

Delegated routes are failing closed because no delegation verification key is configured on an
instance that receives delegated calls (`not_configured`). The usual cause is a rotation mistake that
left `VAULT_DELEGATION_VERIFY_KEYS` empty, or an instance rebuilt without it. Restore the key set from
the deployment's secret store, restart and unseal. If no delegated calls are expected on that instance,
the alert is a probe: there is nothing to fix.

## Sender classification

What the sender does with each response is the sender's contract, summarised in
[`docs/extensions/authoring.md`](../extensions/authoring.md) (the delegated-route section): a
`delegation_expired` or `delegation_not_yet_valid` is retried once with a fresh assertion;
`delegation_wrong_instance` and `delegation_org_not_served` mean re-resolve the instance; a
`delegation_replayed` means mint a fresh assertion once; a generic `delegation_invalid` is
non-retryable and pages an operator; `delegation_actor_not_member`, `delegation_operation_mismatch`,
`delegation_body_mismatch` and `delegation_subject_mismatch` are quarantined. The codes are the ones
`apps/api/src/lib/delegation-stages.ts` answers.

## Logs and metrics reference

Every `delegation.*` log line carries `requestId`, `routeKey` and `outcome`, and when known the
resolved `orgId` and a configured `kid`. None carries the assertion, the header, the actor subject, the
body or a raw assertion id.

| Log event | Meaning |
| --- | --- |
| `delegation.event_suppressed` | A post-signature rejection was answered with its typed code but no security-event row was written, because that `kid` is over its limiter budget. One line per request. |
| `delegation.security_event_timeout` | The security-event write did not finish within 2 s; the typed response was sent without it. |
| `delegation.security_event_write_error` | The security-event write failed; the response is unchanged. |
| `delegation.store_unavailable` | The replay store failed; carries the closed `storeFailure`. |
| `delegation.org_lookup_failed`, `delegation.actor_lookup_failed`, `delegation.burn_input_error` | A lookup failed after verification (`503 service_unavailable`) or the host called the burn with invalid input (a bug). |

Counter outcomes (`pv_delegation_assertions_total`): see the table row in
[`monitoring.md`](monitoring.md). `accepted` is counted once per request the delegation stages admitted;
an unlinked or attested non-member actor counts `actor_unlinked` / `actor_attested_nonmember` **and**
`accepted` for the same request, so do not add them together on a dashboard.

A delegated route also has a default **per-IP limiter** (600 requests per minute per client IP, spent
before any signature check): over the limit the response is `429` with `Retry-After`, counted as
`rate_limited_pre` with `kid="none"`. Behind a reverse proxy the key is the client address Fastify
derives from `TRUST_PROXY` / `TRUST_PROXY_HOPS`, never a raw `X-Forwarded-For` header
([`reverse-proxy-tls.md`](reverse-proxy-tls.md)); IPv6 clients share a bucket per /64. The budget is a
starting value sized for the sender's drain; confirm it against the sender's real peak before release.
