# Native-login exclusion (Story 23.2)

<!-- Source: Story 23.2 AC-17.4; verified against apps/api/src/modules/auth/native-login-policy.ts,
     apps/api/src/scripts/operator-recovery-link.ts, apps/api/src/config/env.ts -->

An installed auth extension whose manifest declares `replacesNativeLogin: true` can, once it has
actually authenticated someone at least once, cause this instance to stop accepting native
email/password credentials on ten routes (`POST /register` subject to the AC-6a bootstrap
carve-out below, `/login`, `/mfa/verify-login`, `/mfa/recover`, all four `/recovery/*` routes, the
external-share password step-up factor, and `POST /org/users/:userId/recovery/send-link`). This is
an accepted, deliberate lockout risk — read this whole document before enabling it, and complete
the pre-flight checklist before the restart that applies exclusion.

## The three environment variables

All three require a **restart** to take effect in either direction. There is no runtime toggle —
this is deliberate: no runtime toggle means no runtime attack surface for flipping the policy via a
request.

| Variable | Effect | Default |
|---|---|---|
| `VAULT_EXTENSIONS_PACKAGE` | Names the npm package to dynamically `import()` as the loaded extension. Unset ⇒ no extension ⇒ native login always stays enabled regardless of the other two vars. | unset |
| `VAULT_NATIVE_LOGIN_REPLACEMENT_CONFIRMED` | Operator opt-out of the AC-4a proving latch: excludes native login on the strength of the manifest declaration alone, without requiring a single proven successful authentication first. **Every boot with this set fires a `warn` operational log** — it stays loud, not a one-time warning. | `false` |
| `VAULT_NATIVE_LOGIN_BREAK_GLASS` | Re-opens the ten gated routes regardless of the other two — see "Break-glass" below. Host/deploy config only; no route, admin setting, or org setting can set it. | `false` |

## The two-state model (why native login might still be up)

Declaring `replacesNativeLogin: true` in the extension manifest is **not**, by itself, enough to
disable native login. The policy resolves to one of four states at boot, from server-side state
only:

1. **`enabled`** — no extension loaded, extension load failed (any reason), extension loaded but
   doesn't declare replacement, or break-glass is active. This is the default, fail-safe state.
2. **`replacement_declared_unproven`** — the extension declares replacement, but no session has
   ever been successfully issued through its auth strategy on this instance. **Native login stays
   enabled.** This is intentional: a declaration alone proves nothing about whether the
   integration actually works. Check the admin diagnostics (`GET /api/v1/admin/extensions/status`)
   — `nativeLoginPolicy.state` will read `replacement_declared_unproven`, and
   `nativeLoginPolicy.replacementProven` will be `false`.
3. **`disabled`** — the extension declares replacement AND (a proven successful login has
   occurred, OR the operator set `VAULT_NATIVE_LOGIN_REPLACEMENT_CONFIRMED=true`). Native login is
   now excluded.
4. **`break_glass`** — see below.

**"Proven" is n = 1.** A single successful SSO/extension login sets a persisted, monotonic latch
(never un-set, read only at boot) that satisfies state 3 on the *next* restart. It says nothing
about whether every user in your organization can actually sign in — see the pre-flight checklist.

## Ordered first-boot bootstrap sequence (AC-6a)

**On a genuinely fresh instance, do this in order — do not enable the extension first:**

1. Boot the instance with `VAULT_EXTENSIONS_PACKAGE` **unset** (or with the extension not yet
   configured).
2. Register the first account: `POST /api/v1/auth/register`. The very first user ever registered
   on an instance is automatically bootstrapped as the platform operator.
3. Verify it worked: `GET /api/v1/auth/me` and confirm `isPlatformOperator: true` in the response.
4. Only now, configure `VAULT_EXTENSIONS_PACKAGE` (and, if applicable,
   `VAULT_NATIVE_LOGIN_REPLACEMENT_CONFIRMED`) and restart.

If you configure the extension with `VAULT_NATIVE_LOGIN_REPLACEMENT_CONFIRMED=true` on a
**genuinely empty** `users` table, `POST /register` still succeeds once — a bootstrap carve-out
evaluated against the live `users` table on every request (never cached at boot) lets exactly the
first registration through even when the resolved policy is otherwise `disabled`. It closes
permanently and automatically the instant that first user exists; every subsequent registration is
gated identically to the other nine routes. Every request that passes through this carve-out
writes a `native_login.bootstrap_register_allowed` audit event (`{ userId, isPlatformOperator }`,
never the email) so you can see in the audit trail exactly when and how the first account was
created.

**If `AUTH_REGISTRATION_ENABLED=false` on a fresh instance**, the carve-out does not fire —
`/register` returns the existing `403 registration_disabled`. The instance is genuinely
unadministrable, and that is your own explicit configuration, not a bug: set
`AUTH_REGISTRATION_ENABLED=true` (even temporarily) to complete step 2 above.

**If the last platform operator's `users` row is ever removed** (compliance erasure, manual
cleanup, an IdP deprovisioning cascade), there is **no in-band remedy** — `resolveIsFirstUser()`
never returns true again, `/register` is gated, and even the break-glass recovery-link CLI (below)
explicitly refuses to create a user. The only path back is direct database access:

```sql
UPDATE users SET is_platform_operator = true WHERE email = '<the account you want to restore>';
```

**Preconditions:** the target row must already exist as a `users` row (this does not create an
account); a partial unique index (`idx_users_one_platform_operator`) still constrains this to
exactly one operator, so running it twice against different emails is safe — only the first
survives. Anyone who can run this already has full database access, so this is not a new privilege
escalation surface; it is simply stated here rather than left as an unstated gap.

## Pre-flight checklist — complete this BEFORE the restart that applies exclusion

Tick every item. This is what stands between "proven, n = 1" and a one-person-locked-out instance:

- [ ] `GET /api/v1/admin/extensions/status` (org-admin, MFA-enrolled) reports
      `nativeLoginPolicy.replacementProven: true` and a non-null `replacementProvenAt`.
- [ ] At least one **non-operator** user has actually signed in through the extension — not just
      the operator's own test login. A single self-test does not validate the integration for your
      user population.
- [ ] Every email domain your users sign in from has an `org_sso_domains` mapping configured, so
      the login screen's domain lookup routes them into the extension flow rather than a dead end.
- [ ] Break-glass is actually reachable for your deployment topology — see the topology table
      below. **If you cannot reach host/deploy config for this instance, you cannot self-recover
      from a lockout and must not proceed without your hosting provider's documented recovery SLA
      in hand.**

## Break-glass topology reachability (AC-8b) — read this before you rely on break-glass at all

Break-glass (`VAULT_NATIVE_LOGIN_BREAK_GLASS`) requires host/deploy-config access — there is no
in-app path to it by design. Whether the locked-out operator actually holds that access depends
entirely on how this instance is deployed. This table is the canonical list; no PV-side document
may describe break-glass as a universal 3am self-service recovery, because for two of these four
rows it is not one:

| Topology | Who holds env/deploy access | Break-glass reachable by the locked-out operator? | What they actually do |
|---|---|---|---|
| Self-hosted Docker / compose | The operator | **Yes** — edit `.env`, `docker compose up -d`, run the `operator:recovery-link` command below | The runbook below applies as written |
| Self-hosted Kubernetes / immutable image | The operator, but via a redeploy | **Yes, with delay** — an env change requires a Secret/ConfigMap edit plus a rollout; the recovery command needs `kubectl exec` into a running pod | The runbook applies; budget for rollout latency, and the pod must reach `Ready` with native login enabled before the command can run |
| **CentralizeMe-hosted (multi-instance sharded topology)** | **CentralizeMe, not the org operator** | **No** | **The org operator cannot self-recover. Recovery is a CentralizeMe support operation** — PV cannot fix this from its own side |
| PV-managed multi-tenant (any future variant where PV operations holds the host) | PV operations | No, for the tenant | Same as CentralizeMe-hosted |

**For the two rows where break-glass is not reachable by the locked-out party, prevention is the
answer, not recovery:**

1. **The AC-4a proving latch is the primary mitigation.** A CM-hosted instance never enters the
   disabled state until the extension has demonstrably authenticated a human on that instance —
   most lockout causes (bad key, JWKS misconfiguration, wrong audience, clock skew, egress
   failure) never reach a state that needs break-glass at all, because they never produce a proven
   successful login in the first place.
2. **`VAULT_NATIVE_LOGIN_REPLACEMENT_CONFIRMED` must NOT be set on CM-hosted instances.** Setting
   it disables the only mitigation the locked-out party has — it skips the proving-latch
   requirement entirely.
3. **CentralizeMe must own a documented, SLA-bearing recovery runbook on its own side**, invoking
   the `operator:recovery-link` command on the org's behalf. This is CentralizeMe's operational
   commitment, not something this document — or any PV-side document — can guarantee for you.

**If you are on a CM-hosted instance, confirm your recovery SLA with CentralizeMe before enabling
exclusion.** Discovering you cannot self-recover during an actual lockout is strictly worse than
discovering it now.

## The AC-8a break-glass recovery-link procedure

Use this when: break-glass is active, the instance is genuinely in the excluded state, and no
human holds a usable native password (every user was provisioned through the extension and holds
an intentionally unusable credential) — the scenario the ordinary self-service recovery email
cannot help with, because outbound email is a second dependency this procedure has none of.

1. Set `VAULT_NATIVE_LOGIN_BREAK_GLASS=true` and restart the instance.
2. On the host/container running the API, run:
   ```bash
   pnpm --filter @project-vault/api operator:recovery-link <email>
   ```
   The command refuses (exit non-zero, prints nothing) unless **all three** hold simultaneously:
   break-glass is active, the loaded extension declares replacement, and the instance is genuinely
   in the excluded state (proven or explicitly confirmed). **On an instance where native login is
   simply enabled, this command always refuses — there is nothing for it to recover.**
3. On success, the command prints a one-time recovery URL to stdout **only** — never to a log file,
   never over email, never anywhere else. If stdout is not a TTY (piped, redirected), it refuses
   unless you explicitly pass `--yes-print-to-pipe`, so the URL is never silently captured into a
   CI log by accident.
4. Paste the printed URL into a browser. It behaves exactly like any other recovery link
   (`GET /recovery/:token` → `POST /recovery/:token/complete`) — set a password, sign in.
5. **No email is involved at any point in this procedure.**
6. Every invocation — minted or refused — writes an audit event recording who ran it (OS user,
   hostname, pid) and the outcome, so a refused invocation is exactly as visible as a successful
   one.
7. Once you've regained access, fix the underlying configuration, then unset
   `VAULT_NATIVE_LOGIN_BREAK_GLASS` and restart. Leaving it set re-enables the entire native-credential
   surface indefinitely and is logged loudly on every subsequent boot for exactly that reason.

## External shares require MFA on excluded instances (AC-6b consequence)

The password factor of the external-share step-up re-authentication is disabled under exclusion —
a sharer with no MFA enrolled can no longer create an external share at all (the password path
existed specifically for that case). `POST /mfa/enroll` remains fully functional. If your users
share credentials externally, ensure they enroll in MFA **before** you enable exclusion, or they
will lose the ability to create new external shares until they do.

## After the cutover restart: ending pre-exclusion sessions (AC-10)

This story ships **no automatic session cap**. A session minted under native auth before the
restart keeps working — indefinitely, through ordinary refresh rotation — even after exclusion
takes effect. This is a deliberate accepted risk (there is no absolute-expiry column on the
`sessions` table to bound against, and adding one is out of scope for this story), not an
oversight.

**The recommended cutover sequence:**

1. Restart with exclusion active.
2. **Confirm** the extension sign-in actually works (do not skip this — you are about to revoke
   your own way back into any session that predates the restart).
3. Only then, call `DELETE /api/v1/auth/sessions` (the existing bulk-revoke-own-sessions route) to
   end sessions minted under native auth.

Revoking before confirming step 2 risks locking yourself out of a session while the extension
integration is still unverified. This ordering is the whole point.

## Remediation for instances that provisioned SSO users before this story (AC-6e)

Before this story, every SSO/extension-provisioned user's password hash was set to one env-wide
value, `env.AUTH_DUMMY_PASSWORD_HASH` — shared across every such user on the instance, and
defaulting (if never explicitly set) to an in-repo, publicly-known constant. This story stops
writing that shared value for **new** provisioning (each new user now gets a fresh, per-user random
non-functional hash) but does **not** retroactively rewrite existing rows — a bulk credential
mutation on boot was judged a worse risk than the one it closes.

**If this instance provisioned SSO users before upgrading to this story, and ran the in-repo
default value:**

1. Set a unique `AUTH_DUMMY_PASSWORD_HASH` for this deployment (any valid Argon2id PHC-format
   string matching your configured `ARGON2_MEMORY_COST`/`ARGON2_TIME_COST`/`ARGON2_PARALLELISM`).
   On any instance whose resolved policy is not plain `enabled`, boot now **fails** if this is
   still the in-repo default — this is intentional and cannot be bypassed by restarting again with
   the same value.
2. Re-provision affected users through the extension (their password hash is refreshed on next
   provisioning), **or** run a scoped update replacing the shared value with fresh per-user
   randomness for exactly the affected rows:
   ```sql
   -- Run once per affected row, or scripted per-row so each gets a DISTINCT random value —
   -- do not reuse a single new hash across rows, which would just recreate the same problem.
   UPDATE users SET password_hash = '<freshly generated, per-row, non-functional Argon2id hash>'
   WHERE password_hash = '<the old shared value>';
   ```
3. Until this remediation is complete, treat break-glass on this instance as higher-risk than
   usual: if the old shared preimage is ever recovered, break-glass is the switch that opens the
   door to every account still carrying it, instance-wide.
