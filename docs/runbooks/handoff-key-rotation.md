# Handoff key rotation and compromise response

<!-- Verified against apps/api/src/config/env.ts,
     apps/api/src/modules/auth/handoff-verify.ts, apps/api/src/modules/auth/handoff-boot.ts,
     apps/api/src/modules/auth/session-revoke.ts (revokeAllUserSessionsInOrg),
     apps/api/src/modules/org/routes.ts (DELETE /users/:userId/sessions),
     apps/api/src/modules/service-provisioning/routes.ts -->

## When to use

The two operations an operator performs against `VAULT_HANDOFF_VERIFY_KEYS` after go-live: a routine,
planned key rotation, and an emergency compromise response.

See [`handoff-instance-identity.md`](handoff-instance-identity.md) for `VAULT_HANDOFF_INSTANCE_ID` /
`VAULT_HANDOFF_VERIFY_KEYS` shape and boot-validation behaviour — this runbook assumes that
groundwork is already in place.

## Background: why this is a fleet-wide, restart-required operation

- This application never fetches keys at request time — `handoffVerifyKeys`
  (`apps/api/src/config/env.ts`) is parsed once, at boot, from `VAULT_HANDOFF_VERIFY_KEYS`. This is
  deliberate: a per-login CentralizeMe/JWKS dependency is exactly what the design avoids.
  **The consequence: adding OR removing a key never takes effect on a running process. Every instance
  must be restarted after any `VAULT_HANDOFF_VERIFY_KEYS` change.** There is no hot reload.
- CentralizeMe signs with one router-wide key for the whole fleet — there are no per-instance issuer
  keys in this version. A rotation or compromise response therefore touches **every instance's**
  `VAULT_HANDOFF_VERIFY_KEYS`, not just one.
- The verifier (`apps/api/src/modules/auth/handoff-verify.ts`) selects a key by exact `kid` match
  only — it never iterates "try every configured key". A token whose `kid` matches neither an old nor
  a newly-added key rejects `handoff_unknown_kid` unconditionally, even during an overlap window.

## Routine key rotation (5 steps)

Follow this exact order — skipping or reordering a step either causes a sign-in outage or re-widens
trust beyond the intended set.

1. **Generate a new Ed25519 keypair in CentralizeMe's custody.** This application never generates or
   holds the private key — key custody is entirely external.
2. **Distribute the new public key and its `kid` to every instance's `VAULT_HANDOFF_VERIFY_KEYS`**,
   appended alongside the existing (still-trusted) old key:

   ```json
   [
     { "kid": "2026-08-key-1", "publicKeyPem": "-----BEGIN PUBLIC KEY-----\n...(old)...\n-----END PUBLIC KEY-----" },
     { "kid": "2026-09-key-2", "publicKeyPem": "-----BEGIN PUBLIC KEY-----\n...(new)...\n-----END PUBLIC KEY-----" }
   ]
   ```

   Restart every instance so the new array is loaded. Confirm each updated boot log shows no
   `VAULT_HANDOFF_VERIFY_KEYS` `FATAL:` env issue.
3. **Confirm every instance trusts both the old and the new key** before CentralizeMe signs anything
   with the new key. A missed instance would reject every handoff token signed with the new key at
   that instance (`handoff_unknown_kid`) while accepting them everywhere else — an inconsistent,
   hard-to-debug partial outage.

   Verify per instance by reading its boot log: the key set is parsed at startup, so a successful boot
   with no `VAULT_HANDOFF_VERIFY_KEYS` `FATAL:` line, plus the handoff-strategy-registered log line,
   means that instance loaded the array you deployed. There is no endpoint that lists the configured
   `kid` values, and nothing in this repository mints a synthetic handoff token, so the only
   end-to-end confirmation available is a real CentralizeMe-originated login after step 4 — which is
   why the boot-log check must cover **every** instance before step 4, not a sample.
4. **CentralizeMe switches to signing with the new key.** Both keys remain configured and trusted
   across the fleet during this step (the overlap window) — tokens signed with either key verify
   successfully.
5. **After at least 120 seconds plus deployment-propagation margin, remove the old key from every
   instance's `VAULT_HANDOFF_VERIFY_KEYS`.** 120 seconds is the maximum acceptance window (60 s max
   token lifetime + 30 s skew before + 30 s margin) — after that, no legitimately-issued token signed
   with the old key can still be outstanding and unconfirmed. Restart every instance again so the
   removal takes effect.

### Rollback

Re-add the old key to every instance's array and restart. Because the verifier matches on exact
`kid`, restoring the old entry restores acceptance of old-key tokens immediately and does not affect
new-key tokens. Only do this to recover from a botched rotation, never after a compromise.

## Compromise response (emergency)

Follow this immediately on suspicion or confirmation that a signing key's private material has
leaked:

1. **Immediately stop signing with the compromised key** (a CentralizeMe-side action — outside this
   repository, but the first and most time-critical step).
2. **Remove the compromised key's public entry from every instance's `VAULT_HANDOFF_VERIFY_KEYS`,
   then restart every instance.** Do this even if it means running with zero or one trusted key
   temporarily — never leave a known-compromised key trusted to buy time.
3. **Accept the deliberate, brief sign-in outage this causes.** Any handoff attempt arriving between
   the compromise and the key's removal taking effect across the whole fleet is exactly the residual
   risk this design accepts. Native login and other already-configured SSO login paths are
   unaffected; only the handoff path is interrupted.
4. **Identify forged sessions from the `handoff_*` event taxonomy**
   (`packages/shared/src/constants/audit-events.ts`'s `HandoffEvent` group, written to
   `platform_security_events` before the org is resolved and to the org-scoped audit log after).
   Look specifically for:
   - `handoff_unknown_kid` spikes (an attacker probing with the compromised key's old `kid` after
     removal, or with an unrelated `kid`).
   - Unexpected user/organization subjects appearing in `handoff_login_succeeded` events around the
     suspected compromise window.
   - `handoff_replay` clusters, which can indicate an attacker racing captured tokens.
5. **Revoke every affected session.** Two operator surfaces exist, and neither is fleet-wide:

   - **Per user, per org** — `DELETE /api/v1/org/users/:userId/sessions` (owner or admin, MFA
     required), called once per user/org pair identified in step 4:

     ```bash
     curl -s -X DELETE http://localhost:${API_HOST_PORT}/api/v1/org/users/<userId uuid>/sessions \
       -H 'Authorization: Bearer <org owner or admin token, MFA verified>'
     # → 200 {"data":{"userId":"<uuid>","revokedCount":N}}
     ```

   - **Per organization** —
     `POST /api/v1/service/organizations/:centralizemeOrganizationId/revoke-sessions`, the
     machine-authenticated route CentralizeMe itself calls. It revokes every session **and** every
     active machine-user API key in that organization. See
     [`service-revocation-token-rotation.md`](service-revocation-token-rotation.md).

   A full-fleet compromise still requires walking every affected organization (or user) by hand. This
   runbook does not provide fleet-wide automatic revocation and should not be described as if it
   does.

### Verify

- Every instance's boot log shows the new key array parsed with no `FATAL:` issue.
- `handoff_unknown_kid` events stop appearing for the removed `kid` (or appear only as rejected
  probes, which is the intended outcome).
- A real CentralizeMe handoff login succeeds end to end on at least one instance per deployment
  group.

## Overlap-window correctness

During step 4 of routine rotation (both keys trusted), the verifier's exact-`kid`-match selection
means:

- A token signed with the **old** key and carrying the old `kid` verifies successfully.
- A token signed with the **new** key and carrying the new `kid` verifies successfully.
- A token carrying **any other `kid`** (a typo, stale config elsewhere, an attacker's guess) rejects
  `handoff_unknown_kid` — the overlap never widens acceptance beyond the exact two configured keys.

## No hot reload — restart is mandatory

Because `handoffVerifyKeys` is parsed once at boot (`parseHandoffVerifyKeys()`, cached in
`apps/api/src/config/env.ts`) and there is no request-time JWKS fetch by design, **every step above
that changes `VAULT_HANDOFF_VERIFY_KEYS` requires a restart of every affected instance to take
effect.** Do not assume a key addition or removal is live until the instance has actually restarted
and its boot logs confirm the new key set parsed without a `FATAL:` issue. This is the stated
trade-off for avoiding a per-login CentralizeMe dependency, not a gap awaiting a hot-reload feature.

Remember that a restart also seals the vault: complete a manual unseal
([`vault-lifecycle.md`](vault-lifecycle.md)) on every restarted instance.

## Cross-link

See [`handoff-instance-identity.md`](handoff-instance-identity.md) for `VAULT_HANDOFF_INSTANCE_ID`
format and boot validation, the full boot-behaviour matrix, and the clock-skew diagnostic signal.
