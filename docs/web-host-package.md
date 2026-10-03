# The `@project-vault/web-host` package

`@project-vault/web-host` is Project Vault's web application **source** (the SvelteKit app in
`apps/web`), published to npm at every Project Vault release. It exists so a build-time composer,
first of all CentralizeMe's composed app, can take PV's exact web source at a pinned version
without a git submodule or monorepo paths, add its own UI on top and build one image (ADR 0007,
decision 6).

It is not a runtime library. Nothing imports it at runtime: a consumer copies its source into its
own app and builds it.

## What is in it

| Path | What it is |
|---|---|
| `src/`, `static/` | Every tracked file under `apps/web/src` and `apps/web/static` except test files. Never a curated subset: a CI check fails if a tracked source file is missing. |
| `messages/`, `project.inlang/settings.json`, `inlang-plugins/` | The translations, the inlang project, and a copy of the pinned message-format plugin (MIT, hash-checked at pack time) that the packed `settings.json` loads, so message compilation works offline. |
| `vendor/shared/src/` | `@project-vault/shared`'s TypeScript source, vendored byte for byte. Only the files reachable from its three entry points are copied. |
| `config/` | Compiled config factories (`.js` + `.d.ts`): `svelte.config`, `vite.config`, `vitest.config`, `app-css-source`. |
| `manifests/compatibility.json` | The compatibility manifest (below). |
| `manifests/injection-points.json` | The injection point registry (Story 68-4), generated at pack time from `injection-points.ts` and the route files that render each point: `{ schemaVersion: 1, points: [{ name, file, kind, propsType, routeId, scope }] }`. The kit reads `name`, `file`, `routeId` and `scope`. |
| `manifests/component-index.json` | Story 68.5: generated into the staging directory on every pack (never committed): `{ schemaVersion: 1, components: [{ path, stability, hash }] }` for every `.svelte` file under `src/lib/components` and every non-test `.ts` module under `src/lib`, sorted by `path`. `hash` is SHA-256 of the raw bytes (the `hostSha256` of a replacement); `stability` is `stable` when the file's first top-level comment carries `@pv-stable` (the first `<!-- -->` of a `.svelte` file, the first `/** */` of a `.ts` file), else `unmarked`. A signal for composers, never a restriction: any module may be replaced. |
| `manifests/hooks-surface.json` | Story 68-6: generated at pack time from PV's `HOOK_SURFACE` and `PV_PROTECTED_PREFIXES`: the SvelteKit hooks PV's composition covers per hooks file (`server`, `universal`, `client`), `headerPolicy: true`, `protectedPaths: true` and PV's own `protectedPrefixes`. The composition kit reads it; with an older web-host that lacks it, hooks and protected paths stay unapplied. |
| `manifests/nav-ids.json` | Story 68-7: generated at pack time from `src/lib/navigation/nav-registry.ts` (never committed): `{ schemaVersion: 1, delta: 1, surfaces: [{ id, file, contextKeys }], ids: [{ id, surface, parent, conditional }] }`, sorted by id (code units). `delta: 1` says this web-host applies a composed app's nav delta. The kit validates a pack's `nav.ts` against it; with an older web-host that lacks it (or `delta`), the nav delta stays unapplied. An empty registry fails the pack. |
| `tsconfig.base.json` | PV's compiler options, for a consumer's `tsconfig.json` to extend. |
| `LICENSE`, `README.md` | AGPL-3.0-or-later, and what the package is. |

PV's **self-contained unit tests** ship too (`src/**/*.test.ts`, decided by Nestor on 2026-10-02),
so a composer can run them over a composed tree (story 68-9) with `vitestConfig()`. The pack
classifies every test structurally and ships it only when its imports stay inside `src/` and the
vendored shared source, it imports no other workspace package, and no relative path in its code
leaves `src/`. Cross-package tests, which read `apps/api`, `packages/db` or PV's own config files,
are excluded and logged with the rule they break. So is the route render snapshot
(`src/routes/route-render-snapshot.test.ts`): it is the oracle of PV's own un-composed markup, so it
is valid only on PV's tree and cannot match once a pack overrides or injects. The packages only the tests import
(`@testing-library/svelte`, `jsdom`, `@vitest/coverage-v8`) are optional exact peers. The consumer
fixture runs every shipped test from the tarball, and they must all pass.

**Composition modules (Story 68-6).** A full override of a hooks file can rebuild PV's pipeline
around its own code from `$lib/server/composition/index.js` (`createPvHandle`, `composeHandles`,
`composeServerHooks`, `PV_HEADER_POLICY`, `composeProtectedPaths`, `PV_PROTECTED_PREFIXES`,
`isProtectedRequest`) and the client-safe `$lib/composition/index.js` (`composeChainHook`,
`composeUniversalHooks`, `composeClientHooks`, `HOOK_SURFACE`, the header-policy functions).
`src/hooks.ts` and `src/hooks.client.ts` exist (empty compositions in PV's build). The vite and
vitest factories include an empty provider for `virtual:pv-hooks/*` that refuses a composed tree
without the kit's `pvHooks()` plugin. See [docs/composition-kit.md](composition-kit.md).

Not shipped: cross-package tests, the PV-tree-only route snapshot, Playwright e2e, generated Paraglide output, build output, the
Dockerfile and PV's dev tooling.

## Using it

Pin the **exact** version, and install every `dependencies` and `peerDependencies` entry at the
exact version the manifest names. Those versions are read from PV's `pnpm-lock.yaml` when the
package is packed. pnpm overrides never reach a consumer, so these are the versions PV actually
builds and tests with. Never install without a version or follow `next`: until the first real
release is promoted, `latest` is a deprecated bootstrap placeholder. The current published state
is in [releasing.md § 9](releasing.md#9-web-host-every-release).

```js
// svelte.config.js
import { svelteConfig } from '@project-vault/web-host/svelte.config'
export default svelteConfig({ alias: { $cm: './src/cm' } })
```

```ts
// vite.config.ts
import { viteConfig } from '@project-vault/web-host/vite.config'
export default viteConfig({ plugins: [myPlugin()] })
```

- Every path is computed from where the package is installed (its own `package.json`, resolved
  through `exports`), never from `../../`. The `@project-vault/shared` aliases point at the vendored
  copy.
- `viteConfig()` keeps PV's plugins in PV's order (Tailwind, the Paraglide compiler, SvelteKit) and
  appends yours. `svelteConfig({ adapter })` replaces only the adapter. `vitestConfig()` merges.
- Compiled messages go to `<appRoot>/src/lib/paraglide`, where `appRoot` (an option of the Vite and
  Vitest factories) defaults to the working directory.
- `src/app.css` marks its `@source` line for the shared source with a
  `@project-vault/web-host: shared-source` comment. In the package it reads
  `../vendor/shared/src/**/*.ts`, relative to `src/`. If your layout differs, rewrite it with
  `rewriteSharedSource()` from `@project-vault/web-host/app-css-source`.

The out-of-monorepo fixture (`scripts/web-host-consumer-fixture/`) is a working minimal consumer.

## The compatibility manifest

`manifests/compatibility.json` (export `@project-vault/web-host/manifest`) records what one release
was built with. Keys are sorted, and the schema is
[`scripts/web-host-compat-manifest.schema.json`](../scripts/web-host-compat-manifest.schema.json).

```json
{
  "apiImageTag": "ghcr.io/nestormata/project-vault/api:1.4.0",
  "extensionApiVersion": "3.25.0",
  "kitVersion": "0.1.0",
  "pvRelease": "1.4.0",
  "schemaVersion": 1,
  "toolchain": { "kit": "2.70.3", "svelte": "5.57.1", "typescript": "6.0.3", "vite": "8.3.1" }
}
```

- `pvRelease` is the release tag without the `v`. It is also the package version.
- `extensionApiVersion` is `packages/extension-api`'s version. The pack fails unless it equals
  `EXTENSION_API_VERSION`.
- `toolchain` comes from the lockfile, never from ranges.
- `apiImageTag` is the API image `container-publish.yml` publishes for the same tag. Both use
  `scripts/lib/release-image.ts`.
- `kitVersion` is the `@project-vault/composition-kit` version this release was built with (its
  `package.json`, asserted equal to the version its build embeds). The composer fails when the app
  resolves a different kit version. See [the composition kit](composition-kit.md).

## How it is built and checked

`pnpm pack:web-host [--version X.Y.Z]` stages the package in `.web-host-pack/` at the repository
root. The directory is gitignored and rebuilt from scratch every time. The pack fails on:

- lockfile drift (a declared range the lockfile does not match);
- a bare import that the lockfile does not resolve;
- a shipped file that imports a test file;
- vendored shared source that reaches outside `packages/shared/src` or imports another workspace
  package;
- a symlink;
- an extension-api version mismatch.

The CI job **`Web-host pack`** runs on every pull request. It checks the paraglide plugin pin and
the tarball content rules (`scripts/check-web-host-tarball.test.ts`). It also runs the
out-of-monorepo consumer fixture: a clean `npm install` of the tarball in a temp directory, then a
build, then every shipped unit test, then booting the built server, which must render `/login`. Run the fixture locally with
`make web-host-fixture`. It is slow and needs the npm registry.

`@project-vault/extension-api` comes from npm at the exact version web-host depends on. While that
version is not published yet (a PR that bumps it, so `npm view` answers E404), PR and local runs
install a tarball packed from `packages/extension-api` instead and print one `fixture:` line saying
so. Any other `npm view` failure fails the fixture. The release workflow sets
`WEB_HOST_FIXTURE_REGISTRY_ONLY=1`, so a release always builds against the published version.

## Releasing

`.github/workflows/web-host-release.yml` runs on the PV `vX.Y.Z` tag push (trigger `v[0-9]*`;
prerelease tags are refused). It does not use a separate tag family, because the web source,
`pvRelease` and the API image are one commit. Before it uploads, the workflow:

1. requires the published GitHub Release and a green `container-publish` run triggered by that
   Release (only reported on a dry run), so the API image named by `apiImageTag` exists;
2. runs the fixture;
3. packs at the tag's version and runs the tarball rules on that exact directory;
4. checks the version triangle (tag, package version, manifest `pvRelease`);
5. confirms the version is not on npm yet.

It then checks that the tag still names the commit it built, and publishes from the Node 24 leg
with OIDC trusted publishing and provenance to the `next` dist-tag. No npm token exists. A
maintainer promotes a verified version to `latest`. npm versions are immutable: never `--force`,
never unpublish, fix forward with a new PV release. See
[releasing.md § 9](releasing.md#9-web-host-every-release) for the release-day runbook, verification
with `scripts/verify-npm-release.ts`, promotion and rollback.
