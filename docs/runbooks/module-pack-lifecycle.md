# Module-pack lifecycle: install, deploy, rollback, health

<!-- Verified against apps/api/src/extensions/loader.ts,
     apps/api/src/extensions/status-routes.ts, apps/api/src/routes/health.ts,
     apps/web/src/routes/(app)/settings/extensions/+page.svelte -->

## When to use

Installing a module pack for the first time, deploying a new version of one, rolling a bad deploy
back, or reading the loaded pack's health and version status.

A **module pack** (a.k.a. "extension") is an npm package this instance loads at boot to extend core
behaviour — for example CentralizeMe's SSO / UI-panel / audit-source extension.

## The model in one sentence

Install, deploy, and rollback are all **the same operation**: set `VAULT_EXTENSIONS_PACKAGE` to
resolve to the module pack version you want, then restart. There is no in-process hot-swap —
**zero-downtime upgrade of the loaded module pack is out of scope.** A deploy of a new module-pack
version is a normal restart-based deploy, nothing more, and the restart seals the vault
([`vault-lifecycle.md`](vault-lifecycle.md)).

## Install (first time)

1. Make the module pack resolvable by the API process's Node module resolution. For a self-hosted
   Docker deployment the supported mechanisms — a derived image, or a read-only bind mount onto
   `/app/node_modules/<name>` — are documented in
   [installing an extension into the production Docker image](../extensions/authoring.md#6-installing-an-extension-into-the-production-docker-image).
   For local development a pnpm workspace package is enough.
2. Set `VAULT_EXTENSIONS_PACKAGE` to that package's name and restart the API process (env var,
   restart-only — no runtime toggle, matching every other extension-affecting setting in this
   codebase, e.g. `docs/runbooks/native-login-exclusion.md`'s three variables).
3. On boot, `loadExtension()` (`apps/api/src/extensions/loader.ts`) performs pre-flight validation
   **before any hook is ever wired up, and before this loaded package can affect any request**:
   - **API-version compatibility gate** — `isExtensionApiVersionSupported()` checks the package's
     declared `manifest.apiVersion` (the extension-API *contract* version it was built against)
     against this host's `EXTENSION_API_VERSION`. An incompatible version fails the load with
     reason `capability_mismatch`.
   - **Manifest shape validation** — `registerExtension()` validates the manifest's required
     fields (name, capabilities, etc.); a malformed manifest fails the load with reason
     `manifest_invalid`.
   - **Bounded timeout** — the `import()` + `hooksFactory()` chain races a timeout (default
     5000ms, `LoadExtensionDeps.timeoutMs`); a hang or crash inside the package's own code fails
     the load with reason `import_error` rather than hanging or crashing the host process.
   - **Never throws, never crashes boot** — every failure path above is caught and recorded as
     in-process state instead. A misconfigured module pack degrades this instance to
     "extension not loaded"; it never prevents the instance itself from starting.
4. Confirm success via the public, unauthenticated `GET /health` endpoint's `extensions_status`
   field — a bare three-value enum, unchanged by this story:

   ```bash
   curl -sf http://localhost:3000/health
   # → {"status":"ok", ..., "extensions_status":"loaded", ...}          (success)
   # → {"status":"ok", ..., "extensions_status":"load_failed", ...}     (pre-flight check failed)
   # → {"status":"ok", ..., "extensions_status":"not_configured", ...}  (VAULT_EXTENSIONS_PACKAGE unset)
   ```

   `/health` intentionally does **not** carry the failure reason, the manifest, or any version
   field — it is a public, unauthenticated liveness endpoint. For the full picture (manifest,
   capabilities, load timestamp, and — new in this story — the loaded package's own release
   version), use the admin-only status endpoint below.

## Deploy a new version

1. Resolve `VAULT_EXTENSIONS_PACKAGE` to the new version (bump the pinned npm version/tag,
   re-publish, or however this instance's package resolution is wired).
2. Restart the API process — identical to any other PV deploy. Migrations, image builds, and
   `docker compose up -d` sequencing are unaffected by this story; see the main
   [`docs/runbook.md`](../runbook.md#upgrades) `## Upgrades` section for the general deploy
   procedure this rides on top of.
3. Re-check `GET /health`'s `extensions_status`, then the admin status endpoint's
   `packageVersion` field (below) to confirm the new version is the one actually loaded.

**Zero-downtime upgrade of the loaded module pack is explicitly out of scope for this story.**
There is no mechanism, planned or implied, for swapping the loaded extension without a process
restart — the restart-based deploy above is the only supported path.

## Rollback a bad deploy

Rollback is **symmetric to deploy**, not a distinct mechanism: point `VAULT_EXTENSIONS_PACKAGE`'s
resolution back at the prior known-good version and restart. Nothing in the loader retains state
across a process restart, so a rollback restart behaves identically to installing that older version
fresh — there is no migration-order or stale-state hazard on this application's side to reason about.

**Verify the rollback actually took**, rather than assuming it did: compare the admin status
endpoint's `packageVersion` before and after the restart (below). `/health`'s `extensions_status`
only says `loaded`, so it cannot distinguish the new version from the old one — a resolution that
silently kept the cached newer package still reports `loaded`.

## Health & version observability

The admin-only `GET /api/v1/admin/extensions/status` endpoint (`allowedRoles: ['admin']`,
`requireMfa: true`) returns the full picture:

```bash
curl -s http://localhost:3000/api/v1/admin/extensions/status \
  -H 'Cookie: <admin session, MFA-verified>'
# → 200 {
#     "extension": {
#       "name": "com.acme.sso-extension",
#       "apiVersion": "1.4.0",        // the extension-API *contract* version — NOT the pack's own release
#       "packageVersion": "3.2.1",    // the loaded package's own package.json "version"
#       "capabilities": ["auth-provider"],
#       "loadedAt": "2026-08-26T10:00:00.000Z"
#     },
#     "nativeLoginPolicy": { ... }
#   }
```

`apiVersion` and `packageVersion` are **independent numbers that can coincidentally look
similar** — do not conflate them. `apiVersion` is governed by `EXTENSION_API_VERSION`
(`packages/extension-api`) and only ever changes when the extension-API contract itself changes;
`packageVersion` is the module pack's own release, chosen entirely by its maintainer. The admin UI
page (`Settings → Extensions`) shows both on separate lines, labelled **"API version"** and
**"Package version"**.

`packageVersion` is read from the loaded package's own `package.json` `version` field at load time
(`apps/api/src/extensions/loader.ts`). It is `null` — never a load failure — whenever that field is
missing, unreadable, or not a string: a module pack is not required to publish a well-formed
`package.json` `version`, and this can never become a new way for a load to fail. The admin UI
renders `null` as "Package version unknown", never a crash or a blank field.

## What this runbook does not cover

This is the host application's own lifecycle mechanism only. A module pack's internal
migration/rollback correctness (for example, database migrations bundled inside its package) is that
package's own responsibility — the loader has no visibility into it and performs no such migration
itself. Consult the module pack's own operator documentation for that half of a deploy or rollback.
