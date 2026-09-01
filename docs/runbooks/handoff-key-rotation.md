# Handoff key rotation and compromise response (Story 30.2)

<!-- Source: Story 30.2 (DW-128) AC8; verified against apps/api/src/config/env.ts,
     apps/api/src/modules/auth/handoff-verify.ts, apps/api/src/modules/auth/handoff-boot.ts,
     apps/api/src/modules/auth/session-revoke.ts (revokeAllUserSessionsInOrg),
     _bmad-output/planning-artifacts/handoff-token-claim-contract.md "Key provisioning, rotation,
     and compromise response" -->

This runbook covers the two operations an operator performs against `VAULT_HANDOFF_VERIFY_KEYS`
after go-live: a routine, planned key rotation, and an emergency compromise response. See
`docs/runbooks/handoff-instance-identity.md` (Story 30.1) for `VAULT_HANDOFF_INSTANCE_ID`/
`VAULT_HANDOFF_VERIFY_KEYS` shape and boot-validation behavior — this document assumes that
groundwork is already in place.

## Background: why this is a fleet-wide, restart-required operation

- PV never fetches keys at request time — `handoffVerifyKeys` (`apps/api/src/config/env.ts`) is
  parsed once, at boot, from `VAULT_HANDOFF_VERIFY_KEYS`. This is deliberate (claim contract "Key
  provisioning" section): a per-login CM/JWKS dependency is exactly what this design avoids.
  **The consequence: adding OR removing a key never takes effect on a running process. Every
  instance must be restarted after any `VAULT_HANDOFF_VERIFY_KEYS` change.** There is no hot
  reload, and none is implied by anything in this story.
- CM signs with one router-wide key for the whole fleet (ADR 0003 — no per-instance issuer keys in
  this version). A rotation or compromise response therefore touches **every PV instance's**
  `VAULT_HANDOFF_VERIFY_KEYS`, not just one.
- The verifier (`apps/api/src/modules/auth/handoff-verify.ts`) selects a key by exact `kid` match
  only — it never iterates "try every configured key" (AC3.10). A token whose `kid` matches
  neither an old nor a newly-added key rejects `handoff_unknown_kid` unconditionally, even during
  an overlap window (AC8.28).

## Routine key rotation (5 steps)

Follow this exact order — skipping or reordering a step either causes a sign-in outage or
re-widens trust beyond the intended set.

1. **Generate a new Ed25519 keypair in CM custody.** PV never generates or holds the private key —
   key custody is entirely `EXTERNAL (CM)`, outside this repository.
2. **Distribute the new public key and its `kid` to every PV instance's
   `VAULT_HANDOFF_VERIFY_KEYS`**, appended alongside the existing (still-trusted) old key:
   ```json
   [
     { "kid": "2026-08-key-1", "publicKeyPem": "-----BEGIN PUBLIC KEY-----\n...(old)...\n-----END PUBLIC KEY-----" },
     { "kid": "2026-09-key-2", "publicKeyPem": "-----BEGIN PUBLIC KEY-----\n...(new)...\n-----END PUBLIC KEY-----" }
   ]
   ```
   Restart every instance so the new array is loaded (see "Background" above). Confirm the
   updated boot log shows no `VAULT_HANDOFF_VERIFY_KEYS` `FATAL:` env issue.
3. **Confirm every instance trusts both the old and the new key** before CM signs anything with
   the new key. A missed instance would reject every handoff token signed with the new key at that
   instance (`handoff_unknown_kid`) while accepting them everywhere else — an inconsistent, hard
   to debug partial outage. Verify via each instance's boot logs or an operator-run smoke test
   against a synthetic token signed with the new key.
4. **CM switches to signing with the new key.** Both keys remain configured and trusted across the
   fleet during this step (the overlap window) — tokens signed with either key verify
   successfully (AC8.28).
5. **After at least 120 seconds plus deployment-propagation margin, remove the old key from every
   instance's `VAULT_HANDOFF_VERIFY_KEYS`.** 120 seconds is the claim contract's maximum
   acceptance window (60 s max token lifetime + 30 s skew before + 30 s margin) — after that, no
   legitimately-issued token signed with the old key can still be outstanding and unconfirmed.
   Restart every instance again so the removal takes effect (Background above — removal is not
   instantaneous or "hot" without a restart).

## Compromise response (emergency)

Follow this immediately on suspicion or confirmation that a signing key's private material has
leaked:

1. **Immediately stop signing with the compromised key** (CM-side action — outside this
   repository, but the first and most time-critical step).
2. **Remove the compromised key's public entry from every PV instance's
   `VAULT_HANDOFF_VERIFY_KEYS`, then restart every instance.** Do this even if it means running
   with zero or one trusted key temporarily — never leave a known-compromised key trusted to buy
   time.
3. **Accept the deliberate, brief sign-in outage this causes.** Any handoff attempt arriving
   between the compromise and the key's removal taking effect (across the whole fleet) is exactly
   the residual risk this design accepts — see the claim contract's threat-3/W6 discussion. Local
   (`local`) and other already-configured SSO login paths are unaffected; only the
   `centralizeme-handoff` handoff path is interrupted.
4. **Identify forged sessions from the `handoff_*` event taxonomy**
   (`packages/shared/src/constants/audit-events.ts`'s `HandoffEvent` group, written per AC6 to
   `platform_security_events` pre-org-resolution and to the org-scoped audit log
   post-org-resolution). Look specifically for:
   - `handoff_unknown_kid` spikes (an attacker probing with the compromised key's old `kid` after
     removal, or with an unrelated `kid`).
   - Unexpected `workosUserId`/`organizationId` subjects appearing in `handoff_login_succeeded`
     events around the suspected compromise window.
   - `handoff_replay` clusters, which can indicate an attacker racing captured tokens.
5. **Revoke every affected session** via the existing per-user path — call
   `revokeAllUserSessionsInOrg` (`apps/api/src/modules/auth/session-revoke.ts`) for each user/org pair
   identified in step 4, OR, for a per-org (not per-user) revocation, use Story 31.1's
   `POST /api/v1/service/organizations/:centralizemeOrganizationId/revoke-sessions` route
   (`revokeAllSessionsForOrg` — see `docs/runbooks/service-revocation-token-rotation.md`), which
   closes DW-130. Neither mechanism is fleet-wide: the former is per-user, the latter is per-org
   (one CM organization at a time, driven by CM's own deprovisioning decisions) — a full-fleet
   compromise still requires walking every affected org (or user) by hand; do not describe this
   runbook as providing fleet-wide automatic revocation.

## Overlap-window correctness (AC8.28)

During step 4 of routine rotation (both keys trusted), the verifier's exact-`kid`-match selection
means:

- A token signed with the **old** key and carrying the old `kid` verifies successfully.
- A token signed with the **new** key and carrying the new `kid` verifies successfully.
- A token carrying **any other `kid`** (typo, stale config elsewhere, an attacker's guess) rejects
  `handoff_unknown_kid` — the overlap never widens acceptance beyond the exact two configured
  keys.

## No hot reload — restart is mandatory (AC8.29)

Because `handoffVerifyKeys` is parsed once at boot (Story 30.1's `parseHandoffVerifyKeys()`, cached
in `apps/api/src/config/env.ts`) and there is no request-time JWKS fetch by design, **every step
above that changes `VAULT_HANDOFF_VERIFY_KEYS` requires a restart of every affected instance to
take effect.** An operator must not assume a key addition or removal is live until the instance has
actually restarted and its boot logs confirm the new key set parsed without a `FATAL:` issue. This
is not a limitation to work around with a future hot-reload feature within this story's scope — it
is the stated tradeoff for avoiding a per-login CM dependency (claim contract, "Key provisioning"
section).

## Cross-link

See `docs/runbooks/handoff-instance-identity.md` (Story 30.1) for `VAULT_HANDOFF_INSTANCE_ID`
format/boot-validation and the clock-skew diagnostics signal referenced above.
