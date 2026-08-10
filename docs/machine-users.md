# Machine Users & CI/CD Credential Access

Machine users are **non-interactive, project-scoped identities** used by CI/CD pipelines and
other automated processes to fetch credential values from Project Vault. Unlike a human user,
a machine user:

- belongs to exactly **one project** (its API key's scope never spans projects),
- authenticates with a long-lived **API key** (`pk_...`) rather than a session/password, and
- has no interactive login — every request goes through the two-step machine-token flow
  described below.

If you're setting up GitHub Actions specifically, prefer
[`packages/vault-action`](../packages/vault-action/README.md), which wraps this flow for you.
This runbook documents the underlying HTTP API directly — useful for GitLab CI, other CI
systems, or debugging.

## The two-step flow

### Step 1 — Exchange the API key for a short-lived access token

```
POST /api/v1/auth/machine-token
Authorization: Bearer pk_...
```

No request body. On success, returns `200`:

```json
{
  "data": {
    "accessToken": "<JWT>",
    "tokenType": "Bearer",
    "expiresIn": 3600
  }
}
```

### Step 2 — Fetch a credential's value using the access token

```
GET /api/v1/machine/projects/:projectId/credentials/:name/value
Authorization: Bearer <accessToken>
```

`:projectId` must match the project the API key (and therefore the access token) is scoped to.
`:name` is the credential's name in that project (URL-encode it if it contains special
characters — a malformed percent-encoding in `:name` currently surfaces as a generic `500`, not
a specific credential error, since decoding happens outside request-schema validation).

An optional `?field=<key>` query parameter retrieves a single field from a structured
(multi-field) credential instead of its whole value.

On success, returns `200`. Without `?field=`:

```json
{
  "data": {
    "name": "DATABASE_URL",
    "value": "postgres://...",
    "versionNumber": 3,
    "cacheable": true
  }
}
```

With `?field=`, `fields` replaces `value` (a `{ [key]: value }` object containing just the
resolved field, or all fields depending on the credential's structure — see the API's OpenAPI
spec/Swagger UI for the exact shape):

```json
{
  "data": {
    "name": "DB_CREDS",
    "fields": { "password": "..." },
    "versionNumber": 3,
    "cacheable": true
  }
}
```

`cacheable` indicates whether this credential is safe for a caller to cache locally (e.g. for
offline/degraded-vault fallback) — see `packages/vault-action`'s offline-cache behavior for one
consumer of this flag.

## Working curl example

Matches the `$VAULT_URL` convention used in `packages/vault-action/README.md` — never hardcode a
host.

```bash
set -euo pipefail

TOKEN=$(curl -sf -X POST "$VAULT_URL/api/v1/auth/machine-token" \
  -H "Authorization: Bearer $VAULT_API_KEY" | jq -r '.data.accessToken')

curl -sf "$VAULT_URL/api/v1/machine/projects/$PROJECT_ID/credentials/DATABASE_URL/value" \
  -H "Authorization: Bearer $TOKEN" | jq -r '.data.value'
```

`set -euo pipefail` matters here: without it, a failed `curl -f` inside `$(...)` doesn't stop the
script, and `TOKEN` silently ends up empty instead of the request failing loudly.

**Careful with the retrieved value** — it's a live secret. Don't `echo` it, don't let it land in
shell history or CI logs uncaptured; assign it straight to an environment variable or masked CI
secret (e.g. GitHub Actions' `::add-mask::`) instead of printing it.

To fetch a single field from a multi-field credential:

```bash
curl -sf "$VAULT_URL/api/v1/machine/projects/$PROJECT_ID/credentials/DB_CREDS/value?field=password" \
  -H "Authorization: Bearer $TOKEN" | jq -r '.data.fields.password'
```

## Token TTL and rotation

- The access token issued in Step 1 is a JWT valid for `MACHINE_JWT_TTL_SECONDS` (default
  **3600 seconds / 1 hour**, must be a positive integer). Both bounds are enforced at server
  startup, not as a runtime clamp: setting it above 3600, or to zero/negative, fails config
  validation and the API refuses to boot — it does not silently cap or reinterpret the value.
- The token is **not renewable/refreshable** — there is no refresh-token endpoint. When it
  expires, re-run Step 1 with the same API key to get a fresh token.
- A revoked or deactivated-owner API key stops being usable at Step 1 immediately; an already
  issued access token stops being accepted at Step 2 as soon as the server re-validates the
  underlying API key row (each Step 2 call re-checks the key's live state, so revocation is
  effective well within the token's remaining TTL — it does not linger for the full hour).
- **API key rotation** has two modes, both performed by an admin from the machine user's detail
  page or its rotate/emergency-revoke API endpoints:
  - **Zero-downtime rotate** — issues a new key immediately and keeps the old key valid for a
    configurable overlap window, so in-flight CI runs using the old key keep working while you
    roll the new key into your secrets store. During that window the old key can still complete
    Step 1 and mint brand-new access tokens — "rotated" is not "revoked" until the window ends.
  - **Emergency revoke** — atomically revokes the old key and issues a new one with **no**
    overlap window; use this if a key is known to be compromised.

## Errors

### Step 1 — `POST /api/v1/auth/machine-token`

| Status | Code | Trigger |
|---|---|---|
| 401 | `access_token_missing` | No `Authorization: Bearer` header present. |
| 401 | `invalid_api_key` | Header doesn't start with `pk_`, the key doesn't match any stored key, or the matched key is revoked/expired/its owning machine user is deactivated. The response is identical for all of these reasons — the endpoint never reveals *why* a key failed. |
| 429 | `rate_limit_exceeded` | Too many failed attempts against the same key hash (10 failed attempts / 60s window), or the IP-based rate limit (20 requests / 60s window) is exceeded. Only the IP-based limit's response body includes a `retryAfter` field (seconds); the key-hash limit's response does not. |

### Step 2 — `GET /api/v1/machine/projects/:projectId/credentials/:name/value`

| Status | Code | Trigger |
|---|---|---|
| 401 | `access_token_missing` | No `Authorization: Bearer` header present. |
| 401 | `invalid_machine_token` | The access token fails signature/expiry verification, has malformed claims, or its underlying API key is no longer live (revoked, expired, or the machine user was deactivated after the token was issued). |
| 403 | `insufficient_role` | The access token is valid but scoped to a **different** project than the `:projectId` in the URL. |
| 404 | `credential_not_found` | No credential with that name exists in the project (or the caller's access to it was denied — the response is the same either way). |
| 409 | `ambiguous_credential_name` (includes `matchCount`) | More than one credential shares that name in the project — machine-user retrieval requires unique names; rename one of the duplicates. |
| 400 | `unknown_field_key` | `?field=<key>` was supplied but that key doesn't exist on the credential. |
| 422 | schema validation error | `?field=` fails request-schema validation. (A malformed percent-encoded `:name` is not caught here — see the note under Step 2's request shape above; it surfaces as a `500`.) |
| 429 | `rate_limit_exceeded` | Either the overall per-key budget (300 requests / 60s window, keyed by the API key's `keyId`) or the tighter anti-enumeration budget (20 **failed** lookups — not-found, ambiguous, or unknown-field responses — per 60s window) is exceeded. The response body includes a `retryAfter` field (seconds). The failed-lookup budget exists specifically so a stolen-but-not-yet-revoked token can't use its full request budget to enumerate credential names by probing; a `503 audit_write_failed` response does **not** count against this failed-lookup budget. |
| 503 | `audit_write_failed` | The credential was resolved but the required audit-log entry could not be written; the request fails closed rather than releasing a secret value without an audit trail. |

## See also

- [`packages/vault-action/README.md`](../packages/vault-action/README.md) — GitHub Actions
  integration built on this same flow, plus offline-cache and matrix/parallel-job guidance.
- [`docs/runbook.md`](runbook.md) — general operational runbook (vault lifecycle, backup/restore,
  incident response).
