# Specifications and research

This directory holds two very different kinds of document, and telling them apart matters.

Four files describe the system that actually ships. The rest are **pre-implementation research**
from an earlier phase of the project, when the intended implementation language was Go. That
implementation was never built: Project Vault is TypeScript on Fastify, Drizzle, PostgreSQL, and
pg-boss. The research documents are kept because their analysis and decision rationale are still
useful, but nothing in them describes running code, and no library, interface, or data structure
they name exists in this repository.

If you want to know how the shipped system works, read [docs/architecture.md](../docs/architecture.md)
first. These specifications go deeper on individual subsystems.

## Implemented and authoritative

These describe the running codebase. Where they disagree with a research document below, these win.

| Specification | Covers | Notes |
|---|---|---|
| [audit-secureroute-and-platform-conventions.md](audit-secureroute-and-platform-conventions.md) | The audit log, route security conventions, migration conventions, and the vault guard, as merged into the codebase | Written explicitly to correct planning documents that misstated the implementation. One section is now out of date: it argues that the audit HMAC is per-row and deliberately *not* chained. As of version 1.2.0 the audit log **is** chain-linked — each row stores the previous row's HMAC — so that verification detects deleted rows. See [docs/architecture.md](../docs/architecture.md). |
| [multi-tenancy-data-model.md](multi-tenancy-data-model.md) | The isolation strategy: a shared schema with an `org_id` on every tenant-owned table, enforced by row-level security | Matches the implementation, including the application role that cannot bypass policies. |
| [vault-initialization-and-key-management.md](vault-initialization-and-key-management.md) | Vault initialization, custody models, the seal/unseal API, Docker wiring, and the operator ceremony | Accurate for the passphrase, envelope, and file custody modes. Two things have moved on: an external key-management-service mode, listed here as reserved and out of scope, is now implemented; and the input key is now split into four derived keys (primary, audit, backup, and platform audit), not the two this document describes. |
| [operational-logging-and-metrics.md](operational-logging-and-metrics.md) | Structured JSON logging to stdout and the Prometheus `/metrics` endpoint, with no second logging library and no tracing stack | Still accurate in substance. The library versions have advanced past the ones named here. |

## Historical research, pre-implementation

Each of these describes a **Go** design that was never built. Status lines inside them referring
to pending decision sign-off refer to that abandoned phase. Read them for the analysis and the
trade-offs, not for the implementation.

| Document | What it proposed | Why it does not describe the product |
|---|---|---|
| [cryptographic-architecture.md](cryptographic-architecture.md) | Shamir secret sharing and a Raft-backed key model | The document itself says so at the top and defers to the vault initialization specification above. What shipped is AES-256-GCM with HKDF and Argon2id, and manual seal/unseal. |
| [rbac-permission-architecture.md](rbac-permission-architecture.md) | Casbin with role-based access control over domains as the authorization engine | Authorization is implemented directly in the application, backed by row-level security in the database. There is no Casbin dependency. |
| [rotation-plugin-architecture.md](rotation-plugin-architecture.md) | A three-tier rotation plugin model over a Go interface, subprocess plugins, and a WebAssembly sandbox, scheduled by a Go job library | Rotation ships as a staged, human-confirmed checklist workflow. Automated provider plugins remain on the roadmap. Background jobs run on pg-boss. |
| [machine-user-auth-offline-caching.md](machine-user-auth-offline-caching.md) | Machine-token flows with an embedded key/value store and NaCl-encrypted offline caching, plus OS keyring storage for developer workstations | The API-key-to-token exchange concept did ship, and so did an encrypted offline cache for CI, but neither the storage engine, the cipher, nor the keyring flow described here exists. |
| [service-health-monitoring.md](service-health-monitoring.md) | Three concurrent HTTP servers, Go health-check and circuit-breaker libraries, and a bundled observability compose stack | The API serves health, readiness, status, and metrics from one server. No circuit-breaker layer and no bundled observability stack ship with the product. |

## Market research

| Document | What it is |
|---|---|
| [secrets-management-market.md](secrets-management-market.md) | Competitive and market intelligence: the landscape, customer segments, pain points, and positioning. Not a specification, and not implementation guidance. |
