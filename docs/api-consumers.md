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

| Scheme                     | Transport                                | Used by                                               |
| -------------------------- | ---------------------------------------- | ----------------------------------------------------- |
| `cookieAuth`               | `access-token` cookie                    | Human/browser sessions. The web app's entire surface. |
| `machineBearer`            | `Authorization: Bearer <JWT>`            | The `/api/v1/machine/**` routes only.                 |
| `apiKey`                   | `Authorization: Bearer pk_...`           | `POST /api/v1/auth/machine-token` only.               |
| `serviceProvisioningToken` | `x-service-provisioning-token: <secret>` | The service-provisioning routes only.                 |

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

### Project roles: a project `viewer` is read-only

Project membership has the same four roles. The **effective project role** of a caller is:

- their organization role, if it is `owner` or `admin` (they bypass project membership);
- otherwise their project membership role, if they have one;
- otherwise their organization role.

Every `POST`, `PUT`, `PATCH` and `DELETE` route under `/api/v1/projects/{projectId}/…` requires an
effective project role of at least `member`, **in addition to** the route's own organization-role
floor and any in-handler check (project owner, project admin, sharer). A caller below it gets:

```json
{
  "code": "insufficient_project_role",
  "message": "Your role in this project does not permit this action"
}
```

with status `403`. No handler code runs and no audit row is written for a refused write. The same
rule covers extension routes under a `:projectId` segment built on `@project-vault/extension-api`
3.37.0 or later, unless the extension declares otherwise for a route (see
[the extension authoring guide](extensions/authoring.md)). Reads are
unchanged: a project viewer can list and open what the project holds, but cannot reveal a secret's
value (the reveal routes have required `member` since Story 4.5).

| Caller                                              | Project write (create, edit, delete, pause, snooze, tag, export, rotate) |
| --------------------------------------------------- | ------------------------------------------------------------------------ |
| Org `owner` / `admin` (any project row)             | allowed, subject to the route's own rules                                |
| Org `member` + project `owner` / `admin` / `member` | allowed, subject to the route's own rules                                |
| Org `member` + project `viewer`                     | `403 insufficient_project_role`                                          |
| Org `member` with no project row                    | the route's own answer (usually `404`, the project is not visible)       |
| Org `viewer` (any project row)                      | `403 insufficient_role` on routes whose org floor is `member`            |
| Platform operator                                   | no bypass: the rows above apply to their org and project roles           |

One write is exempt: `POST …/credentials/{credentialId}/shares/{shareId}/revoke` stays open to a
project viewer, because revoking only narrows exposure; its own rule (the sharer or an org
admin/owner) still applies. The check never tells apart a project in another organization, or one
that does not exist: both fall back to the organization role, and the route returns its usual
`404`. The full per-route list is pinned by
`apps/api/src/__tests__/project-write-role-inventory.test.ts`.

Archiving has one more rule. `POST …/{projectId}/archive`, `…/unarchive` and the same two routes
under `…/credentials/{credentialId}` take an organization floor of `member`, and then the caller
must hold the project's `owner` row or be the organization `owner`. An org `member` who owns the
project may archive it; an org `admin` without the owner row gets `403 insufficient_role`, and an
org `member` with no project row gets `404`. The audit row records `authorizedVia: project_owner`
or `org_owner`. The web app shows its Archive and Unarchive controls by the same rule
(`archiveAuthority` in `@project-vault/shared`).

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

| Parameter | Range         | Default |
| --------- | ------------- | ------- |
| `page`    | integer ≥ 1   | `1`     |
| `limit`   | integer 1–100 | `20`    |

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

| Status | Meaning                                                                                          |
| ------ | ------------------------------------------------------------------------------------------------ |
| `400`  | The request was structurally valid but semantically wrong for this resource.                     |
| `401`  | No credential presented, or the presented one is invalid/expired.                                |
| `403`  | Authenticated, but the role, MFA state, or scope is insufficient.                                |
| `404`  | Not found — also returned instead of `403` where the resource's _existence_ is itself sensitive. |
| `409`  | A conflict with current state (duplicate name, already-revoked key, deactivated identity).       |
| `422`  | Request-schema validation failed (bad body, query, or params).                                   |
| `429`  | Rate limited.                                                                                    |
| `503`  | A required side effect (typically the audit write) failed, so the request failed closed.         |

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

| Route                      | Serves                                                                        |
| -------------------------- | ----------------------------------------------------------------------------- |
| `GET /api/v1/docs`         | Swagger UI.                                                                   |
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

## First-party clients

These clients ship in this repository. The machine-user clients use the schemes listed above;
`pvault login` uses its own bearer-token routes instead, which are not one of those schemes:

- **`packages/vault-action`** and **`packages/agent`**: `apiKey` → `machineBearer` (the
  [machine-user flow](machine-users.md)).
- **`pvault`** ([`packages/cli`](../packages/cli/README.md)):
  - `get`, `run` and `write-env` use `apiKey` → `machineBearer`, like the agent they wrap.
  - `pvault login` uses the CLI's JSON bearer-token routes `POST /api/v1/auth/cli-login`,
    `/api/v1/auth/cli/mfa/verify-login`, `/api/v1/auth/cli/refresh` and `/api/v1/auth/cli/logout`
    (per-IP limits in [`configuration.md`](configuration.md)). No data route accepts that session
    yet.
  - Before `get`, `run`, `write-env` and `login` make any other call, the CLI reads the public,
    unauthenticated `GET /api/v1/client-version-policy` with no credential. A successful answer is
    cached for up to 1 hour per server. `logout`, `--version`, `--help` and a `dev` build never
    read it. An unreachable policy never blocks a command, except when the last successful check for
    that server said this version is withdrawn (a sticky refusal). `PVAULT_NO_VERSION_CHECK` silences
    only the advisory notices, never the request or the withdrawn refusal. Details:
    [`packages/cli/README.md` "Version check"](../packages/cli/README.md#version-check-story-436).

## Audit log: attributed actors and export format version 2

Rows written by an extension on behalf of an external actor (a service-delegated request) carry a
host-verified attribution. PV shows it as an _external_ actor; it never resolves it to a PV user's name.

**`GET /api/v1/org/audit/events`** (owner only) adds an optional `attribution` object to a row, present only
when a valid attribution is stored (the key is absent, not `null`, for every other row):

| Field                                         | Values                                                                                                                                                                                              |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `attribution.actor.kind`                      | `pv_verified` (PV matched the actor to a current member) or `issuer_attested` (PV cannot verify the actor; the issuer vouches for it)                                                               |
| `attribution.actor.reason`                    | `null` for `pv_verified`; `unlinked` (no PV account) or `not_current_member` for `issuer_attested`                                                                                                  |
| `attribution.actor.provider`, `.subject`      | The external identity, as text (provider up to 64, subject up to 256 characters)                                                                                                                    |
| `attribution.occurredAt`, `.occurredAtSource` | When the event happened, and whether that time was `delegation_signed` (issuer-attested) or `extension` (declared by the extension). Display only: ordering, paging and `from`/`to` use `createdAt` |

`actorDisplayName` stays `extension` for these rows. The delegation internals (issuer, key id, assertion id) and
the stored PV user id are never returned. A stored attribution that does not parse (unknown version, odd
shape, control or bidi characters in provider or subject) is shown like a row without one.

**Filter by external actor:** `?actorProvider=<provider>&actorSubject=<subject>` returns the rows attributed to
exactly that external actor (exact, case-sensitive match, all three classes). Both parameters are required
together, and they cannot be combined with `actorId` (the PV-user filter, which never returns delegated rows):
any misuse answers `422` with `code: invalid_actor_filter`.

**CSV export, format version 2.** `POST /api/v1/org/audit/export` produces the same file as before with five
columns **appended** after `ip_address`: `actor_attestation` (`pv_verified`, `issuer_attested`, or empty),
`actor_attestation_reason` (`unlinked`, `not_current_member`, or empty), `actor_provider`, `actor_subject`,
`occurred_at` (ISO 8601 or empty). The first eight columns and their values are unchanged, and rows without an
attribution have five empty trailing fields. **Parse by header name, not by position**: further columns may
be appended in later versions. Provider and subject are neutralised against spreadsheet formulas (a leading
`=`, `+`, `-` or `@` gets a `'` prefix) and RFC 4180 quoted. The integrity verification that precedes every
export is unchanged.

## Audit log: secret fields, copies and reveals (no new event types)

Story 72-8 decided how history names what happened to a secret's fields. **Decision: field-key detail on the
existing events, not new verbs.** `secret.field_added`, `secret.field_changed`, `secret.totp_generated` and
`secret.copied` are **not** event types, and nothing in this section changes `event_type` values, the
`GET /api/v1/org/audit/events` rows or the CSV export (still format version 2, same columns): an event type a
reader or export consumer has never seen would be a breaking change for them, a payload key is not.

What the server writes (all in the event `payload`, key names only, **never a value**):

| Event                        | Payload                                                                                                                                                                                                                                                                                                          |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `credential.version_created` | `versionNumber`, `template`, `addedFields`, `removedFields`, `renamedFields` (`{ from, to }`, when exactly one key left and one arrived) and, new, `changedFields`: keys kept whose value differs from the previous version. `changedFieldsUnknown: true` replaces it if the previous version could not be read. |
| `credential.value_revealed`  | `versionNumber` and, new, `purpose: "copy"` when the value was fetched to be copied without being shown (`GET .../value?purpose=copy`). An absent `purpose` means a view reveal, so rows written before this change read the same way.                                                                           |

A copy row records that **the server released the value to the copy action**, not that the clipboard was
written (the server cannot see the clipboard). `purpose` is asserted by the caller: it labels the request,
it is not proof of what the client then did with the value. A generated TOTP code is audited as a
`credential.value_revealed` with `purpose: "totp"` and `revealedFields: [<field key>]` (story 72-10, see
"Field kinds and one-time passwords" below); the `purpose` enum is additive.

**Consumers never synthesize events.** A client (CentralizeMe included) must not invent history rows or labels
for "copied" or "field changed" from its own UI actions: show only what the audit log returns. Reveal and
TOTP generation are rate-limited **per user** (a bucket per signed-in user, not per IP), and a refused reveal
is indistinguishable from a missing credential for a caller who cannot see the project.

## Field kinds and one-time passwords (TOTP)

Story 72-10 adds an optional `kind` to a credential field, on top of the `sensitive` boolean (which stays the one
secret-versus-visible switch: a visible value is returned with the detail, a sensitive one only through the
audited reveal).

| `kind`      | Meaning                                                                                                                                 |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `text`      | The default. **Never stored**: a field without `kind` is exactly what it was before, so existing credentials read and export unchanged. |
| `multiline` | A value that keeps its line breaks (keys, notes). Only changes how a client types and shows it.                                         |
| `totp`      | A one-time-password **seed**. Always `sensitive` (the server forces it). Write-only, see below.                                         |

`kind` appears in the create and add-version bodies (`fields[].kind`), in the detail's `fields[]` (field metadata,
never a value) and in the reveal response's fields. `CREDENTIAL_TEMPLATE_MAIN_FIELD` in `@project-vault/shared` names
the main field of each template (`login` and `db_connection`: `password`, `api_key`: `key`, `secure_note`: `note`);
it is presentation only and changes nothing that is stored.

**The seed is write-only.** A `totp` field takes a Base32 secret (spaces, dashes and case are ignored) or an
`otpauth://totp/...` link (algorithm SHA1, SHA256 or SHA512, 6 to 8 digits, a 15 to 120 s period). An unusable seed is
`422 invalid_totp_seed`, naming the field key and never the seed. The seed is returned by **no** read:

- `GET .../credentials/:id/value` leaves `totp` fields out of its `fields` (and asking for one with `?field=` answers
  `400 unknown_field_key`, as for a key the secret does not have). Authenticated and external share reveals and the
  machine-user credential read go through the same function, so they never carry a seed either.
- The detail response carries only the field metadata. History and audit rows carry key names only (`changedFields`
  names a replaced seed, never its value).
- **Project export carries the field with an empty seed** (key, `sensitive`, `kind`); after an import the owner
  enters the seed again. This is a deliberate T3 default of story 72-10 (a backup that contains seeds would make the
  export file a second place to steal them from); a later story can add an explicit opt-in.

Editing a secret that has a `totp` field: send the field with an **empty `value`** to keep the stored seed (the
server fills it from the current version), or a new seed to replace it. An empty seed with nothing to keep is
`422 totp_seed_required`. A field is matched by its key (case-insensitive), so renaming a `totp` field means entering
its seed again. A rotation does not manage `totp` seeds; replace them by editing the fields.

**Codes are generated by the server:** `POST /api/v1/projects/:projectId/credentials/:credentialId/totp` with
`{ "field": "<key>" }` answers `{ data: { field, code, digits, periodSeconds, expiresAt, secondsRemaining,
versionNumber, retrievedAt } }` with `Cache-Control: no-store`. The code is valid until `expiresAt`. Rules:

- Same visibility gate and project-role floor as the reveal (member or above), the same `404` for a caller who cannot
  see the project, and the same `credential.value_revealed` audit event, written in the same transaction before the
  code leaves (`payload: { versionNumber, purpose: "totp" }`, `revealedFields: [<key>]`). The code itself is never
  written anywhere.
- **Own rate-limit bucket per user** (60 per minute, key `POST /api/v1/projects/:projectId/credentials/:credentialId/totp`),
  separate from the reveal bucket (120 per minute): polling for codes cannot starve reveals, and the reverse.
- A name that is not a `totp` field of the current version is `422 unknown_totp_field` whether it is absent or another
  kind. A field whose seed is missing or unusable (for example after an import) is `422 totp_seed_unavailable`.
- Codes come from the `otpauth` library (RFC 6238, the same one the sign-in MFA uses); the test suite checks the
  RFC 6238 vectors.

## Projects: edit, links, delete with a grace period and restore

Story 72-9. **Edit.** `PATCH /api/v1/projects/{projectId}` takes `name`, `description` and, new, `urls`
(an array that replaces the whole list; `[]` clears it). Each URL is trimmed, absolute `http` or `https`,
at most 2048 characters, without `user:password@`; at most 10, no case-insensitive duplicates. The overview
(`GET .../{projectId}`) and the PATCH response return `urls`. **Who may edit:** an organization floor of `member`, then the project `owner` row, the organization `owner` or
an organization `admin` (the archive rule plus the org admin; `projectEditAuthority` in `@project-vault/shared`),
checked **before** the body is validated and before any archived or missing state is read, so a caller without
it gets `403 insufficient_role` whatever they send. A project member who does not own the project, and an org
viewer, get `403`. Delete and restore stay narrower (below). An archived project still answers `410`. The audit
row is `project.updated` (it already existed) and its payload is now `{ authorizedVia, changedFields }`, with
`authorizedVia` one of `project_owner`, `org_owner` or `org_admin`, and `changedFields` the **names** of the
fields whose stored value differs (`name`, `description`, `urls`), never the values.

**Delete.** `DELETE /api/v1/projects/{projectId}` (project owner or organization owner, MFA, 10 per minute)
is a soft delete with a **30-day grace period** (`PROJECT_DELETE_GRACE_DAYS` in `@project-vault/shared`).
Authorization is checked first (`403`, then `404` for a project the caller cannot see). The same two blockers as
archive apply (`409 active_rotations`, `409 active_machine_user_keys`); active shares do **not** block, they are
**revoked at delete time**, one `credential.share_revoked` row each with `reason: "project_deleted"`. The response is
`{ id, name, slug, deletedAt, purgeAfter, revokedShareCount }`. The project is also archived (an existing archive
time is kept), and from that moment **every route under `/projects/{projectId}` answers `404 project_not_found`**
(reads and writes, PV's and an extension's), `GET /api/v1/projects` never lists it (not even with
`includeArchived`), and the extension project-membership check denies it. The one exception is restore.
Audit: `project.deleted` with `{ authorizedVia, purgeAfter, revokedShareCount, wasArchived }`.

**Restore.** `POST /api/v1/projects/{projectId}/restore` (same authority and MFA; `409 not_deleted` otherwise)
clears the deletion and returns the project **archived**: unarchive is a separate, explicit step. Shares revoked
at delete time stay revoked. `GET /api/v1/projects/deleted` lists the deleted projects the caller may restore
(an organization owner sees all of them, anyone else the projects they own). Audit: `project.restored`.

**Purge.** The hourly `projects/purge-deleted` job (one transaction per organization and project, RLS bound)
erases the data of a deleted project once `purgeAfter` has passed: its secrets with versions and shares,
rotations, machine users and keys, monitoring records, invitations and memberships. The `projects` row stays as a
**tombstone** (`purged_at` set; name `Purged project`, slug `purged-{id}`, no description, tags or links), because
`audit_log_entries.project_id` references it and the audit log is append-only; the old slug is free again. The job
writes `project.purged` in the same transaction as the erase. Audit rows are never touched. A purged project
cannot be restored.

Consumers: a CentralizeMe `openapi.composed.json` needs the new `urls` field, the `DELETE`, `restore` and `deleted`
routes. The edit authority is not part of the OpenAPI document. Project export (`.../export`) does not carry `urls`, and a deleted project
cannot be exported (`404`).

## Shares index, display status and typed share errors

Story 72-11 (additive; no breaking change).

**Shares index.** `GET /api/v1/shares` (session, organization floor `member`) lists shares across credentials,
newest first. A `member` sees the shares they are the **effective sharer** of (`COALESCE(acting_user_id, shared_by)`,
so a host-created share counts for the human who acted); an organization `admin` or `owner` sees every share of the
organization. A share whose credential sits in a project the caller cannot see (no project membership; org
admin/owner see all projects) is omitted, so its credential name is never disclosed, and shares of a soft-deleted
project are not listed. Query: `status` (`active|viewed|revoked|expired|superseded`), `displayStatus` (below),
`limit` (default 25, clamped to 100, never rejected) and `offset`; an unknown filter value is `422`. Response:
`{ data: { items, total } }`; each item is the share summary plus `credentialName`, `projectId`, `projectName`.
The per-credential list (`GET .../credentials/{credentialId}/shares`) accepts the same `displayStatus` filter.

**Share summary, new fields** (list, create member share, create external share, revoke, index): `displayStatus`,
`lockedAt` (ISO time or `null`), `verificationRequired` (boolean). The persisted `status` is unchanged, and so is
every status an extension sees.

| `displayStatus`                   | Meaning (precedence top to bottom)                                                                               |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `locked`                          | `lockedAt` is set: an attempt cap (guest verification or reveal attempts) closed the share. Wins over `revoked`. |
| `opened`                          | The secret was revealed: `status = viewed`, or an active multi-view share with `viewCount > 0`.                  |
| `active`, `expired`, `superseded` | The persisted status.                                                                                            |
| `revoked`                         | Any other persisted status.                                                                                      |

**Typed reasons.** Sharer-side share errors (create member share, create external share, revoke) carry an additive
`reason` next to the unchanged `code`, from one closed list (`SHARE_ERROR_REASONS` in `@project-vault/shared`).
A reason is sent only **after** authorization and visibility: a caller who cannot see the project or credential
still gets the plain `404`/`403` body with no `reason`. Branch on `reason` when present, else on `code`.

| `reason`               | HTTP                                                                  | `code`                                                                       |
| ---------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `credential_archived`  | 410                                                                   | `credential_archived`                                                        |
| `field_unknown`        | 400                                                                   | `unknown_field_key` (plus `field`)                                           |
| `scope_ambiguous`      | 400                                                                   | `ambiguous_share_scope`                                                      |
| `scope_too_broad`      | 400                                                                   | `too_many_attribute_keys`                                                    |
| `expiry_in_past`       | 400                                                                   | `expires_at_invalid`                                                         |
| `expiry_too_late`      | 400                                                                   | `expires_at_invalid`                                                         |
| `recipient_unknown`    | 400                                                                   | `recipient_not_found`                                                        |
| `recipient_inactive`   | 400                                                                   | `recipient_inactive`                                                         |
| `self_share`           | 400                                                                   | `self_share`                                                                 |
| `must_be_single_use`   | 400                                                                   | `external_share_must_be_single_use` (now answered after the visibility gate) |
| `step_up_required`     | 401                                                                   | `step_up_required`                                                           |
| `external_cap_reached` | 429                                                                   | `external_share_cap_exceeded`                                                |
| `revoke_forbidden`     | 403                                                                   | `insufficient_role`                                                          |
| `already_closed`       | none emitted today: revoking a closed share stays an idempotent `200` |

Consumers: a CentralizeMe `openapi.composed.json` needs the `GET /api/v1/shares` route, the three summary fields,
the `displayStatus` query parameter and the `reason` property on the share error bodies (`ShareApiError`).

## See also

- [`machine-users.md`](machine-users.md) — machine users, API keys, and the CI/CD retrieval flow.
- [`packages/vault-action/README.md`](../packages/vault-action/README.md) — the GitHub Action.
- [`packages/cli/README.md`](../packages/cli/README.md) — the `pvault` terminal CLI.
- [`extensions/README.md`](extensions/README.md) — extending the API surface from an extension.
