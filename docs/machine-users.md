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
This document covers both halves of the story:

- the **management API** an administrator uses to create machine users and issue, rotate, and
  revoke their keys (session-authenticated), and
- the **runtime API** the pipeline itself calls (API-key-authenticated) — useful for GitLab CI,
  other CI systems, or debugging.

---

## Part 1 — The runtime flow

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
`:name` is the credential's name in that project; URL-encode it if it contains special
characters.

> **Known bug — malformed percent-encoding in `:name`.** The route decodes `:name` with
> `decodeURIComponent()` after request-schema validation, so a syntactically invalid escape
> sequence (for example `%zz`) throws and surfaces as a generic `500`, not a `400`/`404`
> credential error. This is a defect, not intended behavior — do not build a client around it.
> Percent-encode `:name` correctly and the case never arises.

An optional `?field=<key>` query parameter retrieves a single field from a structured
(multi-field) credential instead of its whole value.

On success, returns `200`. For a single-value credential the response carries `value`:

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

For a genuinely multi-field credential, `fields` replaces `value`. **`fields` is an array of
objects, not a map** — each entry is `{ "key", "value", "sensitive" }`:

```json
{
  "data": {
    "name": "DB_CREDS",
    "fields": [{ "key": "password", "value": "...", "sensitive": true }],
    "versionNumber": 3,
    "cacheable": true
  }
}
```

With `?field=<key>` the array contains just the requested field; without it, the array contains
every field of the credential.

`cacheable` indicates whether this credential is safe for a caller to cache locally (for
offline/degraded-vault fallback). The bundled agent uses it to refuse to cache a credential the
server has flagged non-cacheable — see
[`packages/agent/README.md`](../packages/agent/README.md#offline-cache).

> **Multi-field credentials are not reachable from `@project-vault/agent` or `vault-action`.**
> The agent's `getSecret(name)` returns a single string and has no field selector, so it always
> requests the route with no `?field=`. When the response comes back in the `fields` shape it
> throws `VaultMultiFieldSecretUnsupportedError` (code `multi_field_secret_unsupported`) rather
> than returning `undefined`. Use `curl` (below) or split the credential into single-value
> credentials if a pipeline needs it.

### Working curl example

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

To fetch a single field from a multi-field credential, select it out of the `fields` array:

```bash
curl -sf "$VAULT_URL/api/v1/machine/projects/$PROJECT_ID/credentials/DB_CREDS/value?field=password" \
  -H "Authorization: Bearer $TOKEN" | jq -r '.data.fields[] | select(.key == "password") | .value'
```

### Token TTL and rotation

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

### Errors

#### Step 1 — `POST /api/v1/auth/machine-token`

| Status | Code | Trigger |
|---|---|---|
| 401 | `access_token_missing` | No `Authorization: Bearer` header present. |
| 401 | `invalid_api_key` | Header doesn't start with `pk_`, the key doesn't match any stored key, or the matched key is revoked/expired/its owning machine user is deactivated. The response is identical for all of these reasons — the endpoint never reveals *why* a key failed. |
| 429 | `rate_limit_exceeded` | Two independent budgets guard this route — see the bodies below. |

The two 429 bodies on Step 1 are **not** interchangeable. The per-IP budget (20 requests / 60s,
counting successes as well as failures) is enforced by the shared route helper and carries
`retryAfter` in seconds:

```json
{
  "code": "rate_limit_exceeded",
  "message": "Too many authenticated requests",
  "retryAfter": 42
}
```

The per-key-hash budget (10 **failed** attempts / 60s, keyed by a hash of the presented key) is
enforced inside the handler and sends a fixed body with **no** `retryAfter`:

```json
{
  "code": "rate_limit_exceeded",
  "message": "Too many failed attempts for this API key"
}
```

Treat the absence of `retryAfter` as "retry after at most 60 seconds" rather than retrying
immediately.

#### Step 2 — `GET /api/v1/machine/projects/:projectId/credentials/:name/value`

| Status | Code | Trigger |
|---|---|---|
| 401 | `access_token_missing` | No `Authorization: Bearer` header present. |
| 401 | `invalid_machine_token` | The access token fails signature/expiry verification, has malformed claims, or its underlying API key is no longer live (revoked, expired, or the machine user was deactivated after the token was issued). |
| 403 | `insufficient_role` | The access token is valid but scoped to a **different** project than the `:projectId` in the URL. |
| 404 | `credential_not_found` | No credential with that name exists in the project (or the caller's access to it was denied — the response is the same either way). |
| 409 | `ambiguous_credential_name` (includes `matchCount`) | More than one credential shares that name in the project — machine-user retrieval requires unique names; rename one of the duplicates. |
| 400 | `unknown_field_key` | `?field=<key>` was supplied but that key doesn't exist on the credential. |
| 422 | schema validation error | `?field=` fails request-schema validation (empty, over-long, or outside the allowed character set). |
| 429 | `rate_limit_exceeded` | Either the overall per-key budget (300 requests / 60s, keyed by the API key's `keyId`) or the tighter anti-enumeration budget (20 **failed** lookups — not-found, ambiguous, or unknown-field responses — per 60s) is exceeded. |
| 500 | `internal_error` | Only ever seen here for the malformed-percent-encoding bug noted above. |
| 503 | `audit_write_failed` | The credential was resolved but the required audit-log entry could not be written; the request fails closed rather than releasing a secret value without an audit trail. |

Both of Step 2's 429s come from the same shared helper, so both bodies carry `retryAfter`:

```json
{
  "code": "rate_limit_exceeded",
  "message": "Too many authenticated requests",
  "retryAfter": 37
}
```

The failed-lookup budget exists specifically so a stolen-but-not-yet-revoked token can't use its
full request budget to enumerate credential names by probing. A `503 audit_write_failed` response
does **not** count against it.

---

## Part 2 — Managing machine users and keys (admin session)

These routes are part of the ordinary, session-authenticated API — they are **not** callable with
a `pk_` key or a machine access token. Every one of them is org-scoped through the caller's
session.

**Roles and guards.** Read routes require org role **`viewer`** or above. Every mutating route
requires org role **`admin`** or above **and an enrolled MFA factor**, and is rate-limited to
**10 requests / 60s** per user per route. All eleven routes live under `/api/v1`.

| Method | Path | Min. role |
|---|---|---|
| `POST` | `/projects/:projectId/machine-users` | admin + MFA |
| `GET` | `/projects/:projectId/machine-users` | viewer |
| `GET` | `/projects/:projectId/machine-users/active-keys` | viewer |
| `GET` | `/machine-users/:machineUserId` | viewer |
| `POST` | `/machine-users/:machineUserId/deactivate` | admin + MFA |
| `POST` | `/machine-users/:machineUserId/api-keys` | admin + MFA |
| `GET` | `/machine-users/:machineUserId/api-keys` | viewer |
| `DELETE` | `/machine-users/:machineUserId/api-keys/:keyId` | admin + MFA |
| `POST` | `/machine-users/:machineUserId/api-keys/:keyId/rotate` | admin + MFA |
| `POST` | `/machine-users/:machineUserId/api-keys/:keyId/emergency-revoke` | admin + MFA |
| `POST` | `/machine-users/:machineUserId/api-keys/:keyId/extend-dormancy` | admin + MFA |

### Create a machine user

`POST /api/v1/projects/:projectId/machine-users` → `201`

```json
{ "name": "ci-deploy", "role": "member", "description": "GitHub Actions deploy pipeline" }
```

`role` is `"member"` or `"viewer"` — the machine user's role *within its one project*, not an org
role. `name` is 1–128 characters; `description` is optional, nullable, and capped at 1024
characters. Unknown body keys are rejected.

The response is the machine-user detail object:

```json
{
  "data": {
    "id": "…uuid…",
    "projectId": "…uuid…",
    "name": "ci-deploy",
    "description": "GitHub Actions deploy pipeline",
    "role": "member",
    "createdBy": "…uuid…",
    "createdAt": "2026-01-01T00:00:00.000Z",
    "deactivatedAt": null,
    "scopeBoundary": { "canAccess": ["…"], "cannotAccess": ["…"] }
  }
}
```

`scopeBoundary` is a plain-language summary of what this identity can and cannot reach, shown in
the UI before any key exists so the scope is explicit at creation time.

Creating a machine user does **not** create a key — do that next.

### List machine users in a project

`GET /api/v1/projects/:projectId/machine-users?page=1&limit=20` → `200`

Paginated (`page` ≥ 1, default `1`; `limit` 1–100, default `20`). Items are the same object as
above **without** `scopeBoundary`, plus pagination meta:

```json
{
  "data": {
    "items": [{ "id": "…", "projectId": "…", "name": "ci-deploy", "role": "member", "…": "…" }],
    "page": 1,
    "limit": 20,
    "total": 1,
    "hasNext": false
  }
}
```

### List the project's active keys

`GET /api/v1/projects/:projectId/machine-users/active-keys` → `200`

An id-only projection used to answer "does anything still hold a live key in this project?"
before an archival or teardown:

```json
{
  "data": {
    "items": [{ "machineUserId": "…uuid…", "keyId": "…uuid…" }],
    "total": 1
  }
}
```

### Get one machine user

`GET /api/v1/machine-users/:machineUserId` → `200`, body identical to the create response
(including `scopeBoundary`). `404` if it does not exist in the caller's org.

### Deactivate a machine user

`POST /api/v1/machine-users/:machineUserId/deactivate` → `200`

No request body. Idempotent.

```json
{ "data": { "id": "…uuid…", "deactivatedAt": "2026-01-01T00:00:00.000Z" } }
```

Deactivation blocks *new* key issuance (subsequent issue attempts return `409
machine_user_deactivated`) and stops every existing key from completing Step 1. Existing keys
remain individually revocable.

### Issue an API key

`POST /api/v1/machine-users/:machineUserId/api-keys` → `201`

```json
{ "name": "github-actions", "expiresAt": "2027-01-01T00:00:00.000Z" }
```

`name` is 1–128 characters. `expiresAt` is **optional**: omit it and the key never expires; when
present it must be a valid ISO-8601 timestamp strictly in the future (a past or present value is
rejected `422`).

```json
{
  "data": {
    "id": "…uuid…",
    "machineUserId": "…uuid…",
    "name": "github-actions",
    "key": "pk_…",
    "expiresAt": "2027-01-01T00:00:00.000Z",
    "createdAt": "2026-01-01T00:00:00.000Z"
  }
}
```

**`data.key` is the plaintext key and is returned exactly once.** Only a hash is stored; there is
no endpoint that can show it again. Copy it straight into your secrets store.

### List a machine user's keys (metadata only)

`GET /api/v1/machine-users/:machineUserId/api-keys?page=1&limit=20` → `200`

```json
{
  "data": {
    "items": [
      {
        "id": "…uuid…",
        "name": "github-actions",
        "expiresAt": "2027-01-01T00:00:00.000Z",
        "lastUsedAt": "2026-06-01T09:12:00.000Z",
        "createdAt": "2026-01-01T00:00:00.000Z",
        "isRevoked": false
      }
    ],
    "total": 1
  }
}
```

The field list is a deliberate allowlist: no key hash and no plaintext can ever leak through this
response, even if the underlying query widens.

### Revoke a key

`DELETE /api/v1/machine-users/:machineUserId/api-keys/:keyId` → `200`

```json
{ "data": { "id": "…uuid…", "revokedAt": "2026-06-01T10:00:00.000Z" } }
```

### Zero-downtime rotate

`POST /api/v1/machine-users/:machineUserId/api-keys/:keyId/rotate` → `201`

```json
{ "overlapMinutes": 240 }
```

`overlapMinutes` is an integer 1–1440 (24 hours), defaulting to **240** (4 hours).

```json
{
  "data": {
    "newKeyId": "…uuid…",
    "key": "pk_…",
    "oldKeyId": "…uuid…",
    "overlapExpiresAt": "2026-06-01T14:00:00.000Z"
  }
}
```

The old key keeps working — including minting brand-new access tokens — until
`overlapExpiresAt`. Roll `data.key` into your CI secret store before then. Rotating an
already-revoked key returns `409`.

### Emergency revoke

`POST /api/v1/machine-users/:machineUserId/api-keys/:keyId/emergency-revoke` → `200`

No request body. Revokes the old key and issues its replacement atomically, with **no** overlap
window — every pipeline still holding the old key breaks immediately, which is the point.

```json
{
  "data": {
    "revokedKeyId": "…uuid…",
    "newKey": "pk_…",
    "newKeyId": "…uuid…"
  }
}
```

Note the field is `newKey` here, not `key` as on rotate.

### Extend (snooze) dormancy

`POST /api/v1/machine-users/:machineUserId/api-keys/:keyId/extend-dormancy` → `200`

```json
{ "days": 30 }
```

`days` is an integer 1–365.

```json
{ "data": { "keyId": "…uuid…", "dormancySnoozedUntil": "2026-07-01T00:00:00.000Z" } }
```

### Key expiry and dormancy

These are two different mechanisms and they are easy to confuse. Only one of them stops a key
from working.

**Expiry stops the key.** If a key was issued with an `expiresAt`, then from that instant Step 1
rejects it with `401 invalid_api_key` — the same opaque response as a revoked or never-issued
key, so a failing pipeline gives you no hint that expiry was the cause. If a CI job that worked
yesterday now fails at token exchange with `invalid_api_key`, check the key's `expiresAt` in the
key-list response first. Keys issued **without** `expiresAt` never expire.

**Dormancy does not stop the key — it alerts you.** A daily job (09:00 UTC) flags every
non-revoked, non-snoozed key whose `lastUsedAt` — or `createdAt`, if it has never been used — is
older than the organization's `machine_key_dormancy_threshold_days`, and raises a security alert
plus an org-admin notification. The threshold defaults to **90** days and may be set to 30, 60,
90, or 180 via `PATCH /api/v1/organizations/:orgId/machine-key-settings`. The key itself keeps
working; nothing is auto-revoked.

Use `extend-dormancy` when a key is *legitimately* idle — a seasonal release pipeline, a
disaster-recovery runbook — to suppress that alert for `days` days without touching `lastUsedAt`.
It is an acknowledgement, not a renewal: it changes nothing about the key's validity or its
`expiresAt`.

## See also

- [`packages/vault-action/README.md`](../packages/vault-action/README.md) — GitHub Actions
  integration built on this same flow.
- [`packages/agent/README.md`](../packages/agent/README.md) — the programmatic Node client and
  its offline cache.
- [`docs/api-consumers.md`](api-consumers.md) — auth modes, pagination, error envelope, and the
  OpenAPI spec.
- [`docs/runbook.md`](runbook.md) — general operational runbook (vault lifecycle, backup/restore,
  incident response).
