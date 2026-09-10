# Rotating the production HMAC and session secrets

<!-- Verified against apps/api/src/config/env.ts, apps/api/src/plugins/{jwt,machine-jwt}.ts,
     apps/api/src/modules/auth/{tokens,recovery-tokens,totp,sso-routes,handoff-routes}.ts,
     apps/api/src/modules/machine-users/tokens.ts, apps/api/src/modules/invitations/tokens.ts,
     apps/api/src/modules/credential-shares/service.ts,
     apps/api/src/modules/monitoring/status-page-tokens.ts,
     apps/api/src/modules/status/token.ts, apps/api/src/modules/compliance/erasure-service.ts,
     docker-compose.prod.yml -->

## When to use

- A secret is suspected leaked (a repository push, a shared `.env`, a compromised host).
- An instance was brought up on a dev or placeholder value and must move to a real one.
- Scheduled hygiene rotation.

**This is not master-key rotation.** These twelve secrets protect tokens, links and hashes; the vault
master key protects the encrypted data itself and is a different, much more constrained subject —
see [`master-key.md`](master-key.md).

---

## The twelve secrets

Every one of these is required in production, must be at least 32 characters, must not be a
placeholder, and must not be one of the published dev-only values. Several must also differ from each
other; boot fails with a `FATAL:` message naming the exact variable if any rule is violated.

All twelve are read once at boot. **No secret in this codebase hot-reloads. Every rotation requires
an API restart, and a restart re-seals the vault, so every rotation also requires an unseal.**

Generate each one independently:

```bash
openssl rand -base64 48
```

Never reuse one value for two variables.

### Blast radius, by secret

| Secret | What it protects | Effect of rotating it | Verify |
| --- | --- | --- | --- |
| `API_KEY_HMAC_SECRET` | The stored HMAC of every machine-user API key | **Every machine-user API key on the instance stops working, permanently.** The plaintext keys cannot be re-derived. CI/CD, automation and any integration authenticating with a `pk_...` key break at once, and each one must be re-issued and redistributed. | Issue one new key and use it; then confirm the old key returns `401`. |
| `MACHINE_JWT_SECRET` | Signature of the short-lived machine JWTs issued by the token-exchange route | Outstanding machine JWTs are rejected. Clients holding a valid API key simply re-exchange and recover on their own; no operator action per client. | A token exchange with a valid API key returns a working JWT. |
| `REFRESH_TOKEN_HMAC_SECRET` | The stored hash of every refresh token | **Every user is forced to log in again.** No refresh token in the database can be matched any more. | Log in, refresh, confirm a new session works. |
| `SESSION_SECRET` | HS256 signature of the access-token JWT | Every outstanding access token is rejected immediately. Because refresh tokens are hashed under a *different* secret, sessions recover on the next refresh — this is a brief interruption, not a forced re-login, unless you rotate `REFRESH_TOKEN_HMAC_SECRET` at the same time. | Load an authenticated page; confirm no `401` loop. |
| `MFA_PENDING_SESSION_HMAC_SECRET` | The stored hash of the short-lived pending-MFA token between password step and TOTP step | In-flight MFA logins fail and must be restarted from the password step. Nothing durable is lost. | Complete one full password → TOTP login. |
| `TOTP_REPLAY_HMAC_SECRET` | The replay-detection record for already-used TOTP codes (`HMAC(userId:counter:token)`) | Existing used-code records stop matching, so a TOTP code already consumed could be accepted a second time within its remaining window (at most ~30–60 seconds). Rotate at a quiet moment; do not rotate while responding to a credential-stuffing incident. | Enter the same TOTP code twice: the second attempt must be rejected. |
| `INVITATION_TOKEN_HMAC_SECRET` | The stored hash of invitation tokens **and**, with a `credential_share:` domain prefix, of credential-share links | **Every pending invitation and every outstanding credential-share link dies.** Recipients get a not-found/invalid result. Invitations must be re-sent and shares re-created. | Create one invitation and accept it end to end. |
| `RECOVERY_TOKEN_HMAC_SECRET` | The stored hash of account-recovery tokens (including operator break-glass recovery links) | Outstanding recovery links stop working. **Do not rotate this while a locked-out operator is mid-recovery** — it invalidates the link they are holding. | Request a recovery link and follow it to completion. |
| `SSO_STATE_HMAC_SECRET` | The hashed SSO `state` value and the handoff flow's own cookie value | In-flight SSO logins and in-flight CentralizeMe handoffs fail; retrying from the start works. Nothing durable is lost. | Complete one SSO login and, if enabled, one handoff. |
| `STATUS_PAGE_TOKEN_HMAC_SECRET` | The stored hash of public status-page access tokens | **Every public status page protected by a token starts rejecting its token.** External consumers see an auth failure until each page's token is regenerated and redistributed. | Load one protected status page with its token. |
| `OPERATIONAL_STATUS_TOKEN_HMAC_SECRET` | The stored hash of the `GET /status` bearer token | Your external monitor starts getting `401` on `/status`. Regenerate the token (Settings → Platform Admin → `POST /api/v1/admin/settings/status-token/rotate`) and re-point the monitor. | `curl -H 'Authorization: Bearer <new>' .../status` → `200`. |
| `ERASURE_EMAIL_HASH_SECRET` | The keyed hash of the original email on erasure requests (`data_erasure_requests.original_email_hash`) | **De-duplication of erasure requests breaks for every historical request.** Existing hashes were computed under the old key and can never be matched again, so a previously-erased address is no longer recognized as such and the re-invite guard that depends on it stops firing for those rows. Rotate only with a deliberate compliance decision. | Submit a repeat erasure request for a *newly* erased address and confirm it is de-duplicated. |

Rules the boot validator enforces beyond "present and long enough": `TOTP_REPLAY_HMAC_SECRET` must
differ from `REFRESH_TOKEN_HMAC_SECRET`, and `MFA_PENDING_SESSION_HMAC_SECRET` must differ from
`SESSION_SECRET`, `REFRESH_TOKEN_HMAC_SECRET` and `TOTP_REPLAY_HMAC_SECRET`.

---

## Rotation procedure

There is no overlap window for any of these — they are single static secrets, so every cutover is a
hard swap. Plan for the blast radius in the table above before you start.

### 1. Decide the scope and the order

If you are rotating because of a suspected leak, rotate **everything that could have been exposed
together** — a leaked `.env` exposes all twelve. If you are rotating for hygiene, prefer this order
so the most disruptive changes happen when you can support them:

1. Low impact, safe any time: `SESSION_SECRET`, `MACHINE_JWT_SECRET`, `SSO_STATE_HMAC_SECRET`,
   `MFA_PENDING_SESSION_HMAC_SECRET`, `TOTP_REPLAY_HMAC_SECRET`.
2. User-visible, announce first: `REFRESH_TOKEN_HMAC_SECRET` (everyone re-logs-in),
   `RECOVERY_TOKEN_HMAC_SECRET`.
3. Requires coordinated re-issuance with third parties: `API_KEY_HMAC_SECRET` (every CI/CD consumer),
   `INVITATION_TOKEN_HMAC_SECRET` (pending invites and shares), `STATUS_PAGE_TOKEN_HMAC_SECRET`,
   `OPERATIONAL_STATUS_TOKEN_HMAC_SECRET`.
4. Compliance decision required: `ERASURE_EMAIL_HASH_SECRET`.

Under leak conditions, do all four groups in one restart rather than four restarts — the exposure
window matters more than the tidiness of the rollout.

### 2. Pre-stage the replacements

- Generate the new values and store them in your secret manager **before** touching the running
  instance, so a failed restart is a rollback, not a scramble.
- For an image-based/compose deployment, `docker-compose.prod.yml` requires each of these as a
  `${VAR:?}` value: the stack refuses to start with any of them unset, which is the intended
  fail-closed behaviour.
- Notify the owners of anything in group 3 above **before** the restart, not after.

### 3. Swap and restart

Update the values in your secret manager / `.env`, then restart the API:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d api
```

Watch the boot logs. A rejected value produces a `FATAL:` line naming the exact variable in the
"Missing or invalid environment variables" block, and the process exits — it never starts on a bad
secret.

### 4. Unseal

The restart re-seals the vault. Complete a manual unseal
([`vault-lifecycle.md`](vault-lifecycle.md)) and confirm `GET /ready` → `{"status":"ready"}`.

### 5. Verify each rotated secret

Run the check in the last column of the table for **each** secret you rotated. Do not treat "the API
booted" as verification — a wrong-but-well-formed secret boots fine and only fails at the moment a
real user or integration needs it.

### 6. Re-issue what you invalidated

- New machine-user API keys, distributed to every consumer, for `API_KEY_HMAC_SECRET`.
- Re-send invitations and re-create credential shares for `INVITATION_TOKEN_HMAC_SECRET`.
- Regenerate each public status page's token, and the `/status` token, for the two status secrets.

### Rollback

Putting the old value back and restarting restores the old behaviour exactly — these secrets are
stateless keys, and nothing in the database is rewritten by a rotation. That is a genuine rollback
option for a hygiene rotation gone wrong. **It is not an option after a leak**: reverting re-exposes
the compromised value.

---

## What this rotation does *not* cover

| Secret | Runbook |
| --- | --- |
| `SERVICE_REVOCATION_TOKEN` | [`service-revocation-token-rotation.md`](service-revocation-token-rotation.md) |
| `SERVICE_PROVISIONING_TOKEN` | Same pattern as the above: dedicated value, hard swap, restart required. |
| `VAULT_HANDOFF_VERIFY_KEYS` (asymmetric, has an overlap window) | [`handoff-key-rotation.md`](handoff-key-rotation.md) |
| `VAULT_BOOTSTRAP_TOKEN` | Only meaningful before init; regenerate freely and restart. |
| The vault master key / envelope halves / KMS key | [`master-key.md`](master-key.md) — rotation is **not supported in v1**. |
| Database role passwords (`vault_app`, `vault_admin`, `vault_extension`, `vault_owner`) | [`disaster-recovery.md`](disaster-recovery.md) and [`extension-db-access.md`](extension-db-access.md) |
