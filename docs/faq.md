# Frequently asked questions

Terms used here are defined in the [glossary](glossary.md).

## Why does the vault need to be unsealed by hand after every restart?

Because the alternative is storing, next to the ciphertext, the thing that decrypts it.

Project Vault keeps its encryption keys only in the API process's memory. A restart clears them,
so the instance comes back **sealed**: the database still holds every encrypted value, and
nothing in the process can read one. Unsealing re-derives the keys from an input only an operator
holds. If the process could unseal itself unattended, then anyone who obtained a copy of the disk
would have both halves of the problem solved.

You are not stuck with typing a passphrase, though. Envelope mode splits the input key into two
16-byte halves — one supplied through the environment, one from a file on disk — so an unattended
restart can complete without a human, while a stolen disk image or a leaked environment dump is
still useless on its own. External key-management-service mode moves the unwrap step to a service
you control. The [architecture overview](architecture.md) covers all four custody modes, and the
[runbook](runbook.md) covers the operational side.

## Why are there separate PostgreSQL roles instead of just one?

Because the application's own role is the one that must **not** be able to see across tenants.

Tenant isolation is enforced by PostgreSQL row-level security, and a superuser bypasses it
silently. If the application ran as the superuser, every policy would be inert and the test suite
would pass with flying colors while proving nothing.

So the roles are split by what each one is allowed to ignore:

- `postgres` (superuser) runs migrations, and creates the roles, policies, and triggers.
- `vault_app` runs the application and the tests, and cannot bypass row-level security.
- `vault_admin` backs a deliberately tiny pool for the handful of operations that genuinely must
  look across organizations.
- `vault_extension` is a least-privilege role for extension database access.

`make bootstrap` wires this up for you, and `make check-rls` verifies that every table is
actually covered. See [architecture](architecture.md) and the two-database-roles section of the
[operator quickstart](operator-quickstart.md).

## Who is the first user?

Whoever registers first on a fresh instance. That account is flagged as the **platform operator**,
and a database constraint permits exactly one on an instance. It gains a Platform Admin page at
`/platform` covering system settings, backups, multi-organization provisioning, per-organization
audit quotas, resource usage, maintenance mode, version and migration-state information, and the
instance-wide audit log — all invisible to every other user.

Register that account yourself, before anyone else can reach the instance, and treat it as a
privileged account: enable multi-factor authentication on it. If it is ever lost, recovering it
takes direct database access — the runbook on native-login exclusion documents the procedure.

## Does `docker compose down -v` destroy my data?

Yes. The `-v` flag removes the named volumes, and that includes the PostgreSQL data volume — every
project, credential, and audit row goes with it.

Use plain `docker compose down` (or `make docker-down`) to stop the stack while keeping the
volumes. Reserve `docker compose down -v` (or `make docker-down-v`) for when you deliberately
want a clean slate on a local development instance. On any instance you care about, take a backup
first; the [runbook](runbook.md) covers backup and restore.

## Is there a hosted version?

Not yet. Project Vault is self-hosted today, and self-hosting is free under AGPL-3.0 — that is
the primary trust path, not a downgrade.

A commercial hosted tier is on the roadmap, adding managed hosting, enterprise and managed single
sign-on, and compliance reporting. Separately, **CentralizeMe** is the maintainer's commercial
hosted SaaS product, which embeds Project Vault as a module; it is not required to self-host and
nothing here depends on it.

The [public demo](https://project-vault-demo-web.fly.dev) is a real deployment you can register
on and explore, but its database resets nightly. It is a scratchpad, not hosting.

## How do I upgrade?

Pull the new images and restart. The one-shot migration service applies schema changes on the way
up, behind a guard that refuses to run a migration it classifies as destructive unless that
migration has been explicitly reviewed.

Before you pull, read the **Upgrade notes** for the target version in
[CHANGELOG.md](../CHANGELOG.md). That section is where migrations needing a maintenance window,
new or newly-required environment variables, and changed API responses are called out. The
[upgrades section of the operations guide](runbook.md#upgrades) has the full procedure, and
[container images](container-images.md) explains the release-tag scheme.

There is no in-app "click to upgrade" button, and that is deliberate: an in-place upgrade of a
self-hosted instance stays an out-of-band operation you control. The Platform Admin version page
is informational — it reports the running release and migration state, and does not act.

## Where do I report a vulnerability?

Privately, never in a public issue. Use GitHub's private vulnerability reporting form; the full
policy, including scope, supported versions, and the response and disclosure timeline, is in
[SECURITY.md](../SECURITY.md).
