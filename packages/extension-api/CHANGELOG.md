# Changelog

The contract hash covers the checked-in public API surface and contract-behaviour snapshots.

## 2.1.0 — 2026-08-19

contract-hash: sha256:bc6d08f603fe27347788f45495c2d332486110eefab11ee5c5c76ba1dace640d

contract-hash: sha256:c2cce524e9651c7e49eb154d85b2088b203cf7c6fbe7b82eb76222253fdb6b8c

### Added

- Added the host-called `project-lifecycle` policy hook so extensions can participate in PV's
  transaction-scoped project-create decision without receiving database access, tier internals,
  or client-controlled tenant context.

## 2.0.0 — 2026-08-19

contract-hash: sha256:e25c0ba61d4c34fca86cc8ec965780cede2e6d33a28d26e427f89b72ecc81ff1

### Breaking

- Added the typed `dbScope` manifest request and `ExtensionRuntimeContext.getDbHandle()` runtime
  boundary for explicitly approved, least-privilege extension database access.
- The public extension API version is now `2.0.0`; extensions must rebuild against this major.
- Added `invalid-db-scope` to the registration error reason union.

## 1.4.0 — 2026-08-18

contract-hash: sha256:0a913707d61153f7e63a88df582f92ed648066fe3af55e340273927055b552bf

### Changed

- Recorded the current public API and contract-behaviour snapshots as the Story 23.6 baseline.

## 1.1.0 — 2026-08-14

### Breaking manifest and gate correction — `[pre-publication-exception]`

This release reverses the load-time compatibility check before the package's first publication.
The policy's pre-publication clause says:

> Changes to the load-time compatibility mechanism made **before the package's first publication** (i.e. before Story 23.1 lands) may ship as a **minor** despite being breaking under AC-4(a), because no out-of-repo party exists to break. **This clause expires automatically at first publication and may never be re-invoked.** Every use of it must be recorded in the CHANGELOG with the marker `[pre-publication-exception]` and the date.

The package remains private, and the known consuming repository has no extension-api dependency or
manifest declaration as of 2026-08-14. This one-time clause covers removal of the public
`isApiVersionCompatible(coreVersion, manifestApiVersionRange)` export as part of the same load-time
compatibility-mechanism change; it is expended by this release and cannot be reused after 23.1
publishes the package.

Extensions now declare the exact canonical version they were built against, and the host owns the
accepted range:

```ts
// before
apiVersion: '^1.0.0'

// after
apiVersion: '1.0.0'
```

The old predicate is replaced by
`isExtensionApiVersionSupported(declaredApiVersion)`. Reversing the direction closes wildcard and
range opt-outs instead of letting an extension author supply the predicate.

An extension that loaded yesterday can stop loading today after either a host upgrade or rollback.
The signal is the `EXTENSION_LOAD_FAILED` operational event and `load_failed` health field; the
remediation is a one-token manifest edit and rebuild against a supported host version. For an
incident rollback, `VAULT_EXTENSIONS_ALLOW_API_VERSION_ABOVE_HOST=true` is an operator-only,
temporary escape for a canonical same-major version above the host. It relaxes only the ceiling,
warns on every boot, and should be followed by rolling the extension back to match. Leaving it on
steady-state can run code against APIs the host does not have and fail as an in-process runtime
`TypeError`.

The declaration remains an unverified claim and the in-process extension is not an isolation
boundary. The range bypass is closed, but provenance is still required to prove that the code was
built against the declared version. The manifest name remains an unbounded echoed input and is
deliberately outside this change. See the load-time-gate section of the versioning policy owned by
Story 23.6 for the residual-risk list and rejected alternatives.

## 1.0.0 — baseline

### Added

- Initial public extension API contract baseline for versioning and deprecation review.
