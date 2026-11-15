# IDENTITY_REVOCATION_JWT_SECRET rotation and compromise response

<!-- Verified against apps/api/src/config/env.ts,
     apps/api/src/modules/service-provisioning/routes.ts,
     apps/api/src/modules/auth/identity-revocation-jwt.ts -->

## When to use

Rotating `IDENTITY_REVOCATION_JWT_SECRET` on a schedule, or responding to a suspected leak.

This secret authenticates `POST /api/v1/service/identities/revoke-sessions`, the trusted-caller
per-identity session revocation route used for sign-out fan-out.

## Background

- The secret is dedicated. Production boot rejects reuse of `SERVICE_REVOCATION_TOKEN`,
  `MACHINE_JWT_SECRET`, `SERVICE_PROVISIONING_TOKEN`, or any other auth secret.
- Tokens are HS256, audience-bound to `node:<VAULT_HANDOFF_INSTANCE_ID>`, TTL 60 seconds, and
  single-use (`jti`).
- Unset is fail-closed: every request is `401 trusted_caller_revocation_rejected`. Unsetting the
  env var and restarting the API is the kill switch.

## Routine rotation

1. Generate a new secret: `openssl rand -base64 32`.
2. Update the caller's signer first so the next minted JWT uses the new value.
3. Set `IDENTITY_REVOCATION_JWT_SECRET` on this node and restart the API.
4. Confirm an old-secret JWT is rejected with `401 trusted_caller_revocation_rejected`.
5. Confirm a new-secret JWT with a fresh `jti` returns `204`.

## Compromise response

1. Unset `IDENTITY_REVOCATION_JWT_SECRET` and restart the API.
2. Rotate as above.
3. Review `platform_security_events` rows for `identity_revocation_rejected` and
   `identity_sessions_revoked_by_trusted_caller`, plus org audit rows
   `identity.sessions_revoked_by_trusted_caller`.
