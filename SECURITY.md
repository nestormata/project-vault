# Security Policy

Project Vault stores credentials, certificates, and operational data that people rely on to keep
production systems running. Vulnerability reports are welcome and taken seriously.

## Reporting a vulnerability

**Do not open a public issue, pull request, or discussion for a security vulnerability.**

Report it privately through **GitHub's private vulnerability reporting** on this repository:

1. Go to <https://github.com/nestormata/project-vault/security/advisories/new>.
2. Describe the issue, the affected version or commit, and the impact.
3. Include reproduction steps, a proof of concept, and any logs or configuration needed to
   reproduce it — with secrets redacted.

That form creates a private advisory visible only to you and the maintainers, and it is the
preferred channel because it keeps the report, the fix, and the eventual advisory in one place.

> **Email fallback — placeholder.** No security contact email address is currently published for
> this project, and none could be verified while writing this policy. If you cannot use GitHub's
> private reporting form, open a public issue that contains **no vulnerability details** — just
> "requesting a private security contact" — and a maintainer will follow up with a channel.
> A maintainer should replace this paragraph with a real address (for example
> `security@<domain>`) and the corresponding PGP key, if any.

Please give the maintainers a reasonable opportunity to ship a fix before disclosing publicly.
We will not take legal action against good-faith research that follows this policy.

## What to include

A useful report usually has:

- The affected component (web UI, API, migration runner, an extension, a published package) and
  the version or commit — the `/health` endpoint reports the running release version.
- The deployment shape: Docker Compose, prebuilt GHCR images, or a source build.
- The vault custody mode (passphrase, envelope, file, external key management service) if the
  issue touches key handling.
- The authentication context: unauthenticated, an ordinary user, a project role, a machine user,
  or the platform operator.
- The impact you believe it has, and whether it crosses an organization boundary.

## Supported versions

Project Vault is released from a single line; there is no long-term-support branch. Only the
latest released minor version receives security fixes.

| Version | Supported |
|---|---|
| 1.2.x | Yes — current release |
| 1.1.x and earlier | No — upgrade to the latest release |
| `main` (unreleased) | Yes, for reports; fixes ship in the next release |

Fixes ship as a new release, with the details recorded in [CHANGELOG.md](CHANGELOG.md) under
Security and, where the severity warrants it, in a published GitHub Security Advisory. Container
images are republished under new immutable tags; existing tags are never rewritten. See
[docs/container-images.md](docs/container-images.md) and [docs/releasing.md](docs/releasing.md).

## Response and disclosure timeline

These are the targets the maintainers work to. Project Vault is maintained by a small team, so
treat them as good-faith commitments rather than a contractual SLA.

| Stage | Target |
|---|---|
| Acknowledge the report | 3 business days |
| Initial assessment and severity triage | 10 business days |
| Fix released for critical and high severity | 30 days from triage |
| Fix released for medium and low severity | Next scheduled release |
| Public disclosure | Coordinated with the reporter, and no later than 90 days after the report |

If a report is still unfixed at 90 days, the maintainers will publish an advisory describing the
issue and any available mitigation, rather than let it sit silently. Reporters are credited in the
advisory unless they ask not to be.

## Scope

**In scope** — anything in this repository that runs as part of a Project Vault deployment:

- The API (`apps/api`), the web application (`apps/web`), and the migration runner.
- Encryption, key custody, sealing and unsealing, and secret handling in `packages/crypto`.
- Tenant isolation: row-level security policies, database roles and grants, and any path that
  allows data to cross an organization or project boundary.
- Authentication and session handling: passwords, multi-factor authentication, recovery flows,
  SSO, browser handoff, machine users and API keys, and the service-provisioning endpoints.
- Audit-log integrity and the ability to suppress, forge, or delete audit records.
- The published packages: `@project-vault/extension-api`, the machine-user agent, and the GitHub
  Action.
- Default configuration and the checked-in Compose files, where a documented default is insecure.
- Supply-chain issues in the build, release, or container-publishing workflows.

**Out of scope:**

- The public demo deployment's data. It resets nightly and is intentionally open to registration;
  a *code* vulnerability found there is in scope, but the data in it is not.
- Findings that require an operator to ignore documented hardening: shipping development secret
  values, running with `COOKIE_SECURE=false` over plain HTTP, exposing the API without a
  TLS-terminating reverse proxy, or granting `VAULT_ALLOW_REMOTE_INIT` in production.
- Anything a platform operator can do by design. The first registered user holds instance-wide
  privileges deliberately.
- Third-party extensions not published from this repository. Report those to their authors; if
  the host allows an extension to escape its documented boundary, that *is* in scope.
- Missing hardening headers, TLS configuration, or rate limits on infrastructure the maintainers
  do not operate.
- Automated scanner output with no demonstrated impact, denial of service through sheer volume,
  and social engineering of maintainers or users.

## A note on the agent package

`packages/agent` contains a maintainer-facing cryptographic synchronization checklist. It is an
internal engineering document, not a vulnerability-disclosure policy — this file is the only
disclosure policy for the project. Report anything you find in that package through the process
above.
