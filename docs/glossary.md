# Glossary

Terms used across Project Vault's documentation, UI, and code, with the distinctions that
routinely trip people up.

### Organization (org)

The top-level tenant. Every project, user membership, credential, and audit row belongs to
exactly one organization, and row-level security in the database enforces that boundary. An
instance can host many organizations. Prose and headings use "organization"; tables, code, and
identifiers use `org`.

### Project

The unit of engineering responsibility, and the thing Project Vault organizes around instead of
an environment. A project groups credentials, certificates, domains, monitored services and
endpoints, payment renewal dates, machine users, and its own membership and roles. Projects can
be archived, transferred to a new owner, and exported and imported.

### Platform operator

The instance-wide administrative **role**. The first user who registers on a new instance is
flagged as the platform operator, and a database constraint permits exactly one. The role is
instance-wide, not organization-scoped: it covers system settings, backups, multi-organization
provisioning, per-organization audit quotas, resource usage, maintenance mode, and the
instance-wide audit log. It is invisible to every other user.

If the platform operator account is lost, recovering it requires direct database access — see the
runbook covering native-login exclusion.

### Platform Admin

The **UI page** the platform operator sees, at `/platform`. It is the screen; "platform operator"
is the role that can open it. The two are not interchangeable: an organization administrator is
not a platform operator and never sees the Platform Admin page.

### Vault, seal, unseal

The "vault" is the encryption layer that protects secret values. **Sealing** clears the derived
encryption keys from the API process's memory; **unsealing** re-derives them from an operator-held
input (a passphrase, an envelope key half, a key file, or an external key management service).

An instance starts sealed after every restart, and that is normal, not a fault. While sealed, the
database still holds every ciphertext, but nothing in the process can read it. See the
[architecture overview](architecture.md) for the key hierarchy.

### Extension

A package the operator installs alongside the application and names in
`VAULT_EXTENSIONS_PACKAGE`. It is loaded in-process at startup against the versioned
[`@project-vault/extension-api`](../packages/extension-api/README.md) contract, and can register
authentication strategies, notification channels and delivery providers, UI panels, module data
routes and typed actions, capability gates, audit-event sources, and project lifecycle hooks.
Loading is fail-safe: a broken extension never blocks boot.

**"Module pack"** is CentralizeMe's name for the same thing — an extension packaged for
installation into a hosted instance. The lifecycle runbook uses that term; everywhere else,
prefer "extension".

### Capability

Two related meanings, distinguished by context. In the extension manifest, a *capability* is one
of the fixed kinds of hook a package declares it provides. In the product, the *capability map*
served at `/api/v1/capabilities` tells the web UI which features the current tier enables, so the
interface can hide or disable what is not available.

### Machine user

A non-human identity scoped to a project, used by continuous-integration jobs and automation. A
machine user holds scoped API keys that can be rotated with an overlap window, revoked in an
emergency, and expired by a dormancy policy. A key is exchanged for a short-lived token, which is
what actually fetches credential values. See [machine users](machine-users.md).

### Break-glass

The emergency path through the staged rotation workflow, for when a credential must be replaced
immediately and the normal per-system confirmation checklist cannot be completed first. It is
deliberately conspicuous: it is audited, it uses a bounded idempotency window and an overlap
period, and it exists so that an emergency does not become a reason to work around the system.

### Handoff

The single-use, signed browser-based single sign-on that lets an already-authenticated
CentralizeMe user land in a Project Vault session without logging in again. The token is verified
with EdDSA, burned on first use to prevent replay, and confirmed through a two-step
prepare/confirm flow that supports a multi-factor challenge. It is opt-in via
`VAULT_HANDOFF_ENABLED` and off by default.

### CentralizeMe

The maintainer's commercial hosted SaaS product, which embeds Project Vault as a module. It is
the first consumer of the extension API and the issuer of the handoff tokens above. It is
closed-source, it is not required to self-host Project Vault, and nothing in this repository
depends on it. Where documentation mentions CentralizeMe-specific behavior — module packs, the
service-provisioning API, organization linking — that behavior is inert on an ordinary
self-hosted instance.

### Service provisioning

The machine-to-machine API a hosted platform uses to create organizations, provision member
identities, link an organization to its upstream record, and revoke handoff sessions
organization-wide. It is guarded by dedicated tokens (`SERVICE_PROVISIONING_TOKEN`,
`SERVICE_REVOCATION_TOKEN`) and is fail-closed while they are unset.

### Row-level security (RLS)

The PostgreSQL feature that enforces tenant isolation in the database rather than only in
application code. Each request sets a transaction-local organization identifier, and every
tenant-owned table's policies filter against it. The application connects as a role that cannot
bypass those policies.

### BMAD

An internal planning methodology the maintainers use. Its artifacts are not part of this
repository and are not needed to build, run, or contribute to Project Vault.
