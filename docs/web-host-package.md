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
| `messages/`, `project.inlang/settings.json`, `inlang-plugins/` | The translations, the inlang project and the vendored message-format plugin (MIT, byte-pinned), so message compilation works offline. |
| `vendor/shared/src/` | `@project-vault/shared`'s TypeScript source, vendored byte for byte. Only the files reachable from its three entry points are copied. |
| `config/` | Compiled config factories (`.js` + `.d.ts`): `svelte.config`, `vite.config`, `vitest.config`, `app-css-source`. |
| `manifests/compatibility.json` | The compatibility manifest (below). Later generated manifests (`injection-points.json`, `nav-ids.json`, `component-index.json`) land here when their stories ship. |
| `tsconfig.base.json` | PV's compiler options, for a consumer's `tsconfig.json` to extend. |
| `LICENSE`, `README.md` | AGPL-3.0-or-later, and what the package is. |

Not shipped: unit tests, Playwright e2e, generated Paraglide output, build output, the Dockerfile
and PV's dev tooling.

## Using it

Pin the **exact** version, and install every `dependencies` and `peerDependencies` entry at the
exact version the manifest names. Those versions are read from PV's `pnpm-lock.yaml` when the
package is packed. pnpm overrides never reach a consumer, so these are the versions PV actually
builds and tests with.

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
  "kitVersion": null,
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
- `kitVersion` is `null` until the composition kit (story 68-3) ships.

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
build, then booting the built server, which must render `/login`. Run the fixture locally with
`make web-host-fixture`. It is slow and needs the npm registry.

## Releasing

`.github/workflows/web-host-release.yml` runs on the PV `vX.Y.Z` tag. It does not use a separate
tag family, because the web source, `pvRelease` and the API image are one commit. Before it uploads,
the workflow:

1. runs the fixture;
2. packs at the tag's version and runs the tarball rules on that exact directory;
3. checks the version triangle (tag, package version, manifest `pvRelease`);
4. confirms the version is not on npm yet.

It then publishes from the Node 24 leg with OIDC trusted publishing and provenance to the `next`
dist-tag. No npm token exists. A maintainer promotes a verified version to `latest`. npm versions
are immutable: never `--force`, never unpublish, fix forward with a new PV release. See
[releasing.md](releasing.md#9-web-host-every-release) for the commands.
