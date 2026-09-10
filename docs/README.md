# Project Vault documentation

Everything written down about running, configuring, extending, and contributing to Project Vault.
If you are new to the product, start with the [README](../README.md); if you are new to the
codebase, start with the [architecture overview](architecture.md).

## I want to…

| I want to… | Read |
|---|---|
| Evaluate the product | The [live demo](https://project-vault-demo-web.fly.dev) and the feature table in the [README](../README.md) |
| Run my own instance | [Operator quickstart](operator-quickstart.md), then the [operations runbook](runbook.md) |
| Deploy prebuilt images | [Container images](container-images.md) |
| Configure it | [Configuration reference](configuration.md) |
| Fetch secrets from a CI/CD job | [Machine users](machine-users.md), [GitHub Action](../packages/vault-action/README.md) |
| Call the API directly | [API consumers](api-consumers.md) |
| Respond to an incident or run a procedure | [Runbooks index](runbooks/README.md) |
| Understand how it works | [Architecture](architecture.md), [glossary](glossary.md), [FAQ](faq.md) |
| Build an extension | [Extensions](extensions/README.md), [`@project-vault/extension-api`](../packages/extension-api/README.md) |
| Contribute code | [Contributing](../CONTRIBUTING.md), [development guide](development.md) |
| Cut a release | [Releasing](releasing.md) |
| Report a vulnerability | [Security policy](../SECURITY.md) |
| See what changed | [Changelog](../CHANGELOG.md) |

## Understanding the system

| Document | What it covers |
|---|---|
| [architecture.md](architecture.md) | Newcomer overview: the services, the request path, row-level security and the database roles, the vault key hierarchy, extension loading, and how the audit HMAC chain works |
| [glossary.md](glossary.md) | Organization, project, platform operator vs the Platform Admin page, seal and unseal, extension and module pack, machine user, break-glass, handoff, CentralizeMe |
| [faq.md](faq.md) | Why manual unseal, why separate database roles, who the first user is, what `down -v` destroys, whether there is a hosted version, how to upgrade, where to report a vulnerability |

## Running an instance

| Document | What it covers |
|---|---|
| [operator-quickstart.md](operator-quickstart.md) | Zero to eval-ready: prerequisites, the two setup paths, database roles, the vault ceremony, email, production hardening, and common failures |
| [container-images.md](container-images.md) | The three published GHCR images, the release-tag scheme, digest pinning, and deploying them from a container manager |
| [configuration.md](configuration.md) | Every environment variable the API accepts, grouped by concern, with defaults and production notes |
| [runbook.md](runbook.md) | The operations guide: an index into the procedure runbooks below |

## Runbooks

One procedure or incident per file. Start at [runbooks/README.md](runbooks/README.md), which maps
a trigger to the file that handles it.

| Runbook | When you need it |
|---|---|
| [vault-lifecycle.md](runbooks/vault-lifecycle.md) | First deploy, unsealing, and clean startup and shutdown |
| [upgrades.md](runbooks/upgrades.md) | Performing an in-place version upgrade, and the offline migration path |
| [upgrade-notes.md](runbooks/upgrade-notes.md) | Version-ordered notes on what a specific upgrade requires |
| [backup-restore.md](runbooks/backup-restore.md) | Taking, validating, and restoring encrypted backups |
| [disaster-recovery.md](runbooks/disaster-recovery.md) | Rebuilding an instance after losing the host or the database |
| [master-key.md](runbooks/master-key.md) | Master-key custody, key material handling, and custody-mode changes |
| [secret-rotation.md](runbooks/secret-rotation.md) | Rotating the instance's own HMAC and session secrets |
| [credential-retention.md](runbooks/credential-retention.md) | Purging superseded credential versions under the retention policy |
| [monitoring.md](runbooks/monitoring.md) | Health, readiness, the token-protected status endpoint, and Prometheus metrics |
| [incident-response.md](runbooks/incident-response.md) | Working a suspected compromise or data-integrity incident |
| [quarterly-checklist.md](runbooks/quarterly-checklist.md) | The recurring maintenance pass, including base-image refreshes |
| [reverse-proxy-tls.md](runbooks/reverse-proxy-tls.md) | Putting a TLS-terminating proxy in front of the API and web services |
| [multi-replica.md](runbooks/multi-replica.md) | Why a single API replica is the only supported topology, and what breaks if you scale out |
| [audit-storage-exhaustion.md](runbooks/audit-storage-exhaustion.md) | Audit storage filling up: preparing for the quota rollout, and recovering an instance that has run out |
| [rls-ownership.md](runbooks/rls-ownership.md) | Verifying and repairing table ownership so row-level security stays effective (with [rls-ownership-rollback.sql](runbooks/rls-ownership-rollback.sql)) |
| [function-executability.md](runbooks/function-executability.md) | The post-migration and post-restore check that no database function is executable by the wrong role |
| [extension-db-access.md](runbooks/extension-db-access.md) | Granting and revoking an extension's least-privilege database access |
| [module-pack-lifecycle.md](runbooks/module-pack-lifecycle.md) | Installing, deploying, upgrading, rolling back, and health-checking an extension |
| [native-login-exclusion.md](runbooks/native-login-exclusion.md) | Disabling native password login safely, and recovering a lost platform operator |
| [handoff-instance-identity.md](runbooks/handoff-instance-identity.md) | Configuring the instance identity, key set, and clock-skew signal for browser-handoff SSO |
| [handoff-key-rotation.md](runbooks/handoff-key-rotation.md) | Rotating handoff signing keys, and responding to a suspected key compromise |
| [service-revocation-token-rotation.md](runbooks/service-revocation-token-rotation.md) | Rotating the service revocation token, and responding to its compromise |

## Design notes

Rationale rather than procedure — why a subsystem works the way it does.

| Document | What it covers |
|---|---|
| [design/audit-quota.md](design/audit-quota.md) | Per-organization audit storage quotas and write-rate limits: the degradation strategy and the trade-offs behind it |
| [design/audit-log-scaling.md](design/audit-log-scaling.md) | How the audit log is expected to grow, and the escalation path as it does |

## Integrating

| Document | What it covers |
|---|---|
| [machine-users.md](machine-users.md) | Non-interactive project-scoped identities: API key to token to credential fetch, with a worked example and an error reference |
| [api-consumers.md](api-consumers.md) | Calling the REST API directly: authentication, the register/login/refresh flow, and the OpenAPI spec |
| [../packages/vault-action/README.md](../packages/vault-action/README.md) | The GitHub Action that fetches credentials into a workflow, including the offline cache fallback |
| [../packages/extension-api/README.md](../packages/extension-api/README.md) | The published extension contract package: hooks, host services, and a minimal extension |

## Extending

| Document | What it covers |
|---|---|
| [extensions/README.md](extensions/README.md) | What an extension is, the hook and host-service catalogue, how to author one, and the versioning and deprecation policy for the contract |

## Developing and releasing

| Document | What it covers |
|---|---|
| [development.md](development.md) | Local setup, the database roles for development, running the suites, and the day-to-day loop |
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | Branching and commit conventions, the local quality gates, adding a migration, changing the extension API, review expectations, and the CLA |
| [releasing.md](releasing.md) | Cutting a release: version choice, pre-flight checks, tagging, watching the workflows, and the package sub-releases |
| [sonarqube.md](sonarqube.md) | Maintainer notes on the SonarCloud analysis and coverage configuration |
| [../CHANGELOG.md](../CHANGELOG.md) | Released versions, their changes, and their upgrade notes |
| [../SECURITY.md](../SECURITY.md) | Vulnerability disclosure: how to report, supported versions, timeline, and scope |
| [../specs/README.md](../specs/README.md) | The specification set, sorted into what describes the running system and what is superseded research |
