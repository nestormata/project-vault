# Consuming the Project Vault API

This is the orientation guide for anyone writing a client against Project Vault's HTTP API: the
conventions that hold across every route, where the machine-readable specification lives, and how
to check your client against it.

If your goal is specifically CI/CD secret retrieval, read
[`machine-users.md`](machine-users.md) instead — it documents that flow end to end. This page is
the general contract.

## Base URL and versioning

Every documented route is served under `/api/v1`.

That prefix is the compatibility boundary. Within `v1`, routes and response fields are added but
never removed, renamed, or narrowed in a way that breaks an existing consumer; a change that
cannot be made additively ships under a new prefix instead. Concretely, a client may rely on:

- a documented route continuing to exist at the same path and method,
- a documented response field continuing to be present, with the same type,
- a documented error `code` continuing to mean the same thing.

A client must **not** rely on the absence of fields — new optional fields appear in responses
without a version change — nor on the exact wording of any `message`.

## Authentication

Four mechanisms exist. They are not interchangeable; each is accepted only by the routes it was
designed for.

| Scheme | Transport | Used by |
|---|---|---|
| `cookieAuth` | `access-token` cookie | Human/browser sessions. The web app's entire surface. |
| `machineBearer` | `Authorization: Bearer <JWT>` | The `/api/v1/machine/**` routes only. |
| `apiKey` | `Authorization: Bearer pk_...` | `POST /api/v1/auth/machine-token` only. |
| `serviceProvisioningToken` | `x-service-provisioning-token: <secret>` | The service-provisioning routes only. |

### Session (`cookieAuth`)

A successful login sets an `access-token` cookie; send it on subsequent requests. Most routes
additionally enforce an **organization role** (`viewer` < `member` < `admin` < `owner`), and many
mutating routes additionally require the caller to have an **enrolled MFA factor** — a session
without one gets a `403` even at the right role. Where a route requires a role, that requirement
is documented with the route in the module docs; see [`machine-users.md`](machine-users.md) for a
worked example of how the two guards combine.

Note that `owner` is not universally treated as a superset of `admin`. A small number of routes
gate on the literal role `admin` — the extension-status routes are the notable case — so an
organization's owner is refused there. This is deliberate, not a bug.

### Machine token (`apiKey` → `machineBearer`)

Non-interactive callers use a two-step exchange: present a `pk_` API key to
`POST /api/v1/auth/machine-token`, receive a short-lived project-scoped JWT, then use that JWT on
`/api/v1/machine/**`. The key itself is never accepted on a resource route. Full details, error
table, and rotation semantics: [`machine-users.md`](machine-users.md).

### Service provisioning token

A deployment-wide shared secret, sent in the `x-service-provisioning-token` header, for the
service-provisioning routes. When the secret is not configured those routes are unreachable and
answer `403` for every request — the same response as a wrong token, so absence leaks nothing.

## Response envelopes

A successful response wraps its payload in `data`:

```json
{ "data": { "id": "…", "name": "…" } }
```

A list response puts the rows in `data.items` with pagination metadata alongside them:

```json
{
  "data": {
    "items": [{ "id": "…" }],
    "page": 1,
    "limit": 20,
    "total": 137,
    "hasNext": true
  }
}
```

A few narrower list routes (those that cannot grow unboundedly, such as a machine user's key
list) return `data.items` with only `total` and no page/limit — check the spec for the route you
are calling rather than assuming.

## Pagination

List routes accept two query parameters:

| Parameter | Range | Default |
|---|---|---|
| `page` | integer ≥ 1 | `1` |
| `limit` | integer 1–100 | `20` |

`page` is 1-based, not 0-based. `hasNext` is computed as `page * limit < total`, so paging is
`while (hasNext) page++`. Requesting a page past the end returns an empty `items` array with
`hasNext: false` — not a `404`.

Some list routes additionally cap the reachable offset (`page * limit`) to bound deep-paging
cost, and reject a request past that cap rather than scanning. Filter down instead of paging deep.

## Error envelope

Errors are a **flat** object — they are not wrapped in `data`:

```json
{ "code": "credential_not_found", "message": "No credential with that name exists" }
```

- `code` is a stable, machine-readable, `snake_case` identifier. Branch on it.
- `message` is human-readable English intended for a log or an operator. It is not stable, not
  localized, and must never be parsed.
- Individual errors may carry extra fields — `retryAfter` on a rate-limit refusal, `matchCount`
  on an ambiguous-name conflict. These are documented per route in the spec.

Common status codes carry consistent meanings across the API:

| Status | Meaning |
|---|---|
| `400` | The request was structurally valid but semantically wrong for this resource. |
| `401` | No credential presented, or the presented one is invalid/expired. |
| `403` | Authenticated, but the role, MFA state, or scope is insufficient. |
| `404` | Not found — also returned instead of `403` where the resource's *existence* is itself sensitive. |
| `409` | A conflict with current state (duplicate name, already-revoked key, deactivated identity). |
| `422` | Request-schema validation failed (bad body, query, or params). |
| `429` | Rate limited. |
| `503` | A required side effect (typically the audit write) failed, so the request failed closed. |

Note that a `503 audit_write_failed` is a deliberate fail-closed, not an outage: Project Vault
refuses to release a secret it could not record releasing. Retry it; do not treat it as a
permanent error.

## Rate limiting

Routes are budgeted per authenticated identity, or per client IP where the route is public.
Exceeding a budget returns:

```json
{ "code": "rate_limit_exceeded", "message": "Too many authenticated requests", "retryAfter": 42 }
```

`retryAfter` is in **seconds**. A small number of refusals are emitted by specialized limiters
and omit it (the per-key-hash limiter on the machine-token exchange is the one you are most
likely to meet) — when it is absent, back off for the route's window, which is 60 seconds
everywhere. The audit-write rate refusal additionally sets a standard `Retry-After` response
header.

Budgets differ by route family; the ones a machine consumer cares about are tabulated in
[`machine-users.md`](machine-users.md). Client guidance: back off on `429` rather than retrying
immediately, and do not fan out a large CI matrix onto a single API key.

## The OpenAPI specification

The full OpenAPI 3.0 document is **checked into the repository** at
[`packages/shared/openapi.json`](../packages/shared/openapi.json). It is generated, never
hand-edited: `apps/api/src/scripts/generate-spec.ts` boots the real application, reads back the
document `@fastify/swagger` derived from every route's Zod schema, and writes it out. That is why
it cannot drift from the routes it describes.

Regenerate it with:

```bash
make generate-spec
```

The committed file is **freshness-gated in CI**: the pipeline regenerates it and runs
`git diff --exit-code packages/shared/openapi.json`. Any change to a route's schema must be
accompanied by a regenerated spec in the same commit, or the build fails.

`info.version` is pinned to `dev` in the committed artifact so the file is byte-identical
wherever it is generated. A running instance reports its real release version instead.

### Swagger UI and the live spec route

Both are **off by default**. A self-hosted secrets product should not publish a browsable map of
every authenticated route and its exact schemas without an operator saying so.

Enable them by setting `ENABLE_API_DOCS=true` (they are also on automatically when `NODE_ENV` is
`development` or `test`). When enabled:

| Route | Serves |
|---|---|
| `GET /api/v1/docs` | Swagger UI. |
| `GET /api/v1/openapi.json` | The same document `make generate-spec` writes, with the live release version. |

Both routes are unauthenticated when enabled, and both remain reachable while the vault is
sealed. When disabled they are not registered at all — they return a plain `404`, and they do not
appear in the spec either, so their absence leaks nothing.

## Contract tests

`packages/api-contract-tests` is an independent conformance suite that checks the running API
against the committed specification, rather than against the same Zod schemas the API is built
from. Use it as a reference for what "conforming" means, and run it if you change a route.

What it asserts:

- It enumerates **every** `path` + `method` pair in `packages/shared/openapi.json` and exercises
  each one against a real application instance backed by a real migrated Postgres.
- For each call, the actual response status must be one the spec documents for that operation.
- When the spec documents a JSON schema for that status, the actual response body must validate
  against it (via `ajv`).
- Every operation documenting `401` is re-invoked unauthenticated and must actually produce one.
- Every `/api/v1/admin/**` operation documenting `403` is re-invoked with an authenticated
  non-platform-operator session and must actually produce one.

Routes that declare no response schema at all are detected structurally and smoke-tested for an
unexpected `5xx` rather than status-matched — there is no declared contract to check. Closing one
of those gaps means adding a real response schema to the route, after which the suite starts
enforcing it automatically.

Run it with a database available:

```bash
make db-up
pnpm --filter @project-vault/api-contract-tests test
```

## See also

- [`machine-users.md`](machine-users.md) — machine users, API keys, and the CI/CD retrieval flow.
- [`packages/vault-action/README.md`](../packages/vault-action/README.md) — the GitHub Action.
- [`extensions/README.md`](extensions/README.md) — extending the API surface from an extension.
