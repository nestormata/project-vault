# Architecture

A newcomer's overview of how a Project Vault instance is put together: what runs, how a request
flows through it, how tenants are kept apart, where the encryption keys come from, how extensions
load, and where the audit trail lives.

For terms used here, see the [glossary](glossary.md). For running an instance, start with the
[operator quickstart](operator-quickstart.md).

## Components

A deployment is four services plus a mail sink in development:

| Service | What it is | Notes |
|---|---|---|
| `db` | PostgreSQL 16 | The only durable store. No Redis, no message broker, no object store except optional S3 backup targets. |
| `migrate` | One-shot migration runner | Runs the guarded migration script and exits. Compose orders it before the API. |
| `api` | Fastify 5 (TypeScript) | The whole backend: REST API, authentication, encryption, the extension host, and the background workers. |
| `web` | SvelteKit 2 (Svelte 5, Tailwind v4) | Server-rendered UI. Talks to the API over HTTP; holds no secrets of its own. |
| `mailpit` | Local SMTP sink | Development only. Production points the SMTP settings at a real provider. |

A short-lived `admin-provision` helper also runs in the development Compose stack; it sets the
password on the administrative database role that the migration creates.

Nothing terminates TLS. The API listens on plain HTTP and expects a reverse proxy in front of it;
it emits HSTS headers and requires `COOKIE_SECURE=true` in production so browsers only return
session cookies over HTTPS.

### Background jobs

Scheduled and deferred work runs on [pg-boss](https://github.com/timgit/pg-boss) — a job queue
that lives in the same PostgreSQL database — hosted **inside the API process**, not as a separate
worker container. Around thirty workers cover expiry alerts (credentials, certificates, domains,
machine keys), monitoring health checks, notification delivery and digests, backup snapshots and
retention, audit retention pruning and per-organization storage reconciliation, credential-share
expiry, rotation staleness recovery, machine-key dormancy, and several security sweeps
(anomalous access, failed-authentication thresholds, key custody, clock skew).

The practical consequence: scaling the API horizontally also multiplies the job runners, so jobs
are written to be idempotent and several use pg-boss's singleton keys.

## The request path

A typical authenticated API call:

1. **Reverse proxy** terminates TLS and forwards to the API. When `TRUST_PROXY` is enabled, the
   API reads the client address from the forwarded headers, up to `TRUST_PROXY_HOPS`.
2. **Fastify plugins** apply security headers (Helmet, including HSTS), CORS from
   `CORS_ALLOWED_ORIGINS`, rate limits, and CSRF protection for cookie-authenticated writes.
3. **Authentication** resolves the caller. Human users present a short-lived access cookie backed
   by a refresh cookie; machine users exchange an API key for a short-lived token first. The
   result is an authenticated context carrying the user or machine identity, the organization,
   and the role.
4. **The vault guard** rejects any route that needs plaintext while the vault is sealed. Sealed
   is a normal state after a restart, not a fault.
5. **Authorization** checks the organization role and, for project-scoped routes, the project
   membership and permission — including the split between reading a secret's metadata and
   revealing its value.
6. **The handler** runs its database work inside an organization-scoped transaction (see below),
   decrypting secret values with the in-memory primary key only when the route actually returns
   one.
7. **The audit write** happens in the same transaction as the change it records, so an action and
   its audit row commit or fail together.

The web application is a thin server-rendered client over the same public API. There are no
privileged operations that exist only in the UI.

## Tenant isolation: row-level security and database roles

Isolation is enforced by PostgreSQL, not only by application code. Every tenant-owned table
carries an `org_id` and has row-level-security policies keyed to a transaction-local setting.

Each request opens a transaction and sets that context first:

```sql
SELECT set_config('app.current_org_id', $1, true),
       set_config('app.current_user_id', $2, true);
```

The third argument makes the setting transaction-local, so it cannot leak to the next request
through a pooled connection. Platform-operator routes use a parallel
`app.platform_operator_verified` flag for the instance-wide audit table.

Four database roles exist, and which one a connection uses is the whole security story:

| Role | Connection string | Bypasses RLS? | Used for |
|---|---|---|---|
| `postgres` | superuser | Yes | Migrations only. Creates the other roles, the policies, and the triggers. |
| `vault_app` | `DATABASE_URL` | **No** | The application itself, the test suite, and the RLS coverage check. |
| `vault_admin` | `ADMIN_DATABASE_URL` | Yes | A deliberately tiny pool for the few operations that must see across organizations — for example checking a global erasure record during registration. Its default maximum connections is 3. |
| `vault_extension` | `EXTENSION_DATABASE_URL` | **No** | A least-privilege role for extension database access, granted only the tables an extension is allowed to touch. |

Running the application or the tests as the superuser silently disables every policy and produces
false-green results, which is why `make bootstrap` wires the roles for you and `make check-rls`
verifies that every table is actually covered.

## The vault and the key hierarchy

Secret values are encrypted with AES-256-GCM using keys that exist only in the API process's
memory. On every restart the vault starts **sealed**: the database holds ciphertext, the process
holds no keys, and an operator must unseal it before secrets can be read or written. There is no
key material on disk that would let the process unseal itself.

Unsealing produces a single input key, from one of four custody modes:

| Mode | Input | Notes |
|---|---|---|
| `passphrase` | An operator-typed master passphrase | Stretched with Argon2id using parameters stored at initialization. |
| `envelope` | Two 16-byte halves combined | One half comes from `VAULT_ENVELOPE_KEY_HALF` in the environment, the other from a file on disk. Neither half alone is useful. This is the default for unattended deployments. |
| `file` | A key file at a configured path | The whole input key sits in one file; protect it accordingly. |
| `kms` | A data key unwrapped by an external key management service | The wrapped key is stored in the database; the service unwraps it at unseal time. |

That input key is never used directly. Four independent keys are derived from it with HKDF, each
with its own context label, and the input is zeroed immediately afterward:

- **primary** — encrypts credential values and other secret payloads
- **audit** — keys the per-organization audit HMAC
- **backup** — encrypts backup snapshots
- **platform audit** — keys the instance-wide operator audit HMAC

Compromising a backup archive therefore does not yield the key that would let an attacker forge
audit rows, and vice versa. Sealing the vault clears all four from memory.

## Audit logs and the HMAC chain

There are two separate append-only logs:

- **`audit_log_entries`** — per-organization actions, visible to that organization's
  administrators. RLS-scoped like any other tenant table.
- **`platform_audit_events`** — instance-wide privileged actions by the platform operator,
  visible only to them, with a maintenance-mode failsafe so privileged work cannot proceed while
  the log is unwritable.

Every row carries an HMAC-SHA256 over its own canonicalized fields, computed with the derived
audit key — so editing a stored row invalidates it. Since the chain-linking change, each row
**also stores the previous row's HMAC** and carries a database-generated, gapless `chain_seq`
identity column. The previous HMAC is one of the fields covered by the row's own HMAC, which is
what links them.

Verification walks a chain in `chain_seq` order and reports one of three failures:
`hmac_mismatch` (a row was edited), `key_version_mismatch` (a row was written under a different
audit key), or `chain_break` (a row's stored predecessor HMAC does not match the row that
actually precedes it — that is, a row in the middle of the chain was deleted).

The known residual gap: deleting rows from the **tail** of a chain leaves a shorter but
internally consistent chain, which verification cannot detect on its own. Chain verification
detects tampering and interior deletion, not truncation.

## Extension loading

An extension is an npm package the operator installs alongside the application and names in
`VAULT_EXTENSIONS_PACKAGE`. The API loads it **in-process at startup**, against the versioned
[`@project-vault/extension-api`](../packages/extension-api/README.md) contract.

Loading is fail-safe by design. The host checks the package's declared contract version against
the range it supports, validates the manifest and its declared capabilities, and calls the
package's hook factory under a timeout. Any failure is recorded as one of a fixed set of reasons —
import error, invalid manifest, or capability mismatch — never a raw exception message, and the
instance boots without the extension rather than refusing to start. The result is visible to
administrators on the extension status page and written to the audit log.

A loaded extension registers hooks the host calls at defined points: authentication strategies,
notification channels and delivery providers, UI panels with their navigation entries, module
data routes and typed actions, capability gates, audit-event sources, and project lifecycle and
archive notifications. In the other direction, the host passes in a `HostServices` object —
monitoring, notification origination, organization and project authorization checks, and
short-lived ephemeral state — so an extension never reaches into the database directly for those.
When an extension does need its own tables, it connects through the least-privilege
`vault_extension` role.

Extension calls are bounded by timeouts and are not allowed to block the request path
indefinitely. The compatibility contract, its versioning rules, and the deprecation notice window
are documented with the [extension docs](extensions/README.md).

## Where to go next

- [Operator quickstart](operator-quickstart.md) — get an instance running.
- [Operations runbook](runbook.md) and the [runbooks index](runbooks/README.md) — day-two work.
- [Configuration reference](configuration.md) — every environment variable.
- [Extension docs](extensions/README.md) — build against the contract described above.
- [Glossary](glossary.md) and [FAQ](faq.md).
