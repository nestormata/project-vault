# Writing your first extension

A complete walkthrough: scaffold a package, write a manifest and a hook, build it, load it into a
Project Vault instance, and confirm it is actually running. Then, at the end, how to get it into a
production Docker deployment.

Read [README.md](README.md) first for the capability, hook, and host-service catalogues — this
page assumes you know which hook you want.

## 1. Scaffold

An extension is an ordinary ESM npm package. Nothing about it is Project Vault-specific except its
default export.

```sh
mkdir my-extension && cd my-extension
pnpm init
pnpm add -D typescript @types/node
pnpm add @project-vault/extension-api
```

Declare the SDK as a **peer dependency** rather than a hard dependency wherever you can. The host
process already has its own copy; a second one in your package's tree is legal but means
`instanceof` checks can fail across the two copies (see the SDK README's "Compatibility and two
copies").

### `package.json`

```json
{
  "name": "@acme/vault-extension",
  "version": "1.0.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "files": ["dist"],
  "peerDependencies": {
    "@project-vault/extension-api": ">=3.0.0"
  },
  "scripts": {
    "build": "tsc"
  }
}
```

`"type": "module"` is required — the host imports your package with `import()`. `main` must point
at a real, built file; the loader resolves your package by name and then walks up from the
resolved entry point to read your `package.json`, so both must exist at runtime.

### `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "declaration": true,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

## 2. Write the manifest and the hook

`src/index.ts`:

```ts
import type {
  AuthResult,
  AuthStrategy,
  ExtensionHooks,
  ExtensionManifest,
} from '@project-vault/extension-api'
import { EXTENSION_API_VERSION, defineExtension } from '@project-vault/extension-api'

const manifest: ExtensionManifest = defineExtension({
  name: 'com.acme.sso',
  apiVersion: EXTENSION_API_VERSION,
  capabilities: ['auth-provider'],
})

const authStrategy: AuthStrategy = {
  async onAuthenticate(credential: string): Promise<AuthResult> {
    // Verify `credential` against your identity provider here.
    return { externalSubject: credential, providerName: manifest.name }
  },
}

const hooksFactory = (): ExtensionHooks => ({ authStrategy })

export default { manifest, hooksFactory }
```

### Manifest field rules

| Field | Rule |
|---|---|
| `name` | Reverse-DNS, matching `^[a-z0-9]+(\.[a-z0-9-]+)+$` — at least two dot-separated segments, lowercase, digits and `-` allowed after the first segment. `com.acme.sso` passes; `AcmeSSO` and `acme` do not. It also namespaces any audit rows you write (`ext.com.acme.sso.*`), so pick it once and keep it. |
| `apiVersion` | Exactly one version, never a range. **Always write `EXTENSION_API_VERSION`, never a literal** — see below. |
| `capabilities` | A non-empty array. Each declared capability unlocks its matching hook; returning a hook you did not declare is a manifest error. |
| `replacesNativeLogin` | Optional. Only legal alongside `auth-provider` **and** an actual `authStrategy` hook. Declaring it alone disables nothing — the host also requires a proving latch before it will turn native login off. |
| `uiPanelSlots`, `moduleActions`, `moduleDataRoutes` | Optional, and only legal alongside `ui-panel`. |
| `dbScope` | Optional and operator-approved: a request for a separate least-privilege database handle. |

### Why `EXTENSION_API_VERSION` rather than a version string

The host accepts `>=MAJOR.0.0 <=<the host's own version>` and rejects everything else. Hardcoding
a literal is the single most common way to ship an extension that no host will load: the string
does not move when you upgrade the SDK, so it silently rots until it falls below the host's major
floor and every load fails with `capability_mismatch`.

Using the constant means the manifest always declares exactly the copy you compiled against. The
trade-off is that you must not install an SDK **newer** than the host runs — the ceiling will
reject you. Pin the dependency to a version your target hosts support. For a deliberate,
temporary rollout overlap, an operator can set
`VAULT_EXTENSIONS_ALLOW_API_VERSION_ABOVE_HOST=true`, but that is an escape hatch, not a plan.

### `hooksFactory` and host services

`hooksFactory` is called once, at boot. Declare a `host: HostServices` parameter if you need to
call back into Project Vault:

```ts
import type { HostServices } from '@project-vault/extension-api'

let host: HostServices | null = null
const hooksFactory = (injected: HostServices): ExtensionHooks => {
  host = injected
  return { authStrategy }
}
```

A factory that declares no parameter stays valid forever — that is why adding a service is always
an additive change. Bind the object once, as above; do not cache the request-scoped values its
methods return.

The whole `import()` + `hooksFactory()` chain is raced against a **5-second** timeout. Do no
network I/O and start no long-lived work at module load or in the factory; a slow factory is
indistinguishable from a crash and both fail the load with `import_error`.

## 3. Build

```sh
pnpm build
```

Confirm `dist/index.js` exists and that `node -e "import('./dist/index.js').then(m => console.log(m.default.manifest))"` prints your manifest. If that fails locally it will fail in the host.

## 4. Load it into a development instance

Point `VAULT_EXTENSIONS_PACKAGE` at your package's **name**, not a path:

```sh
VAULT_EXTENSIONS_PACKAGE=@acme/vault-extension pnpm --filter @project-vault/api dev
```

The loader resolves the name through ordinary Node resolution from the API's own `node_modules`,
so the package must be installed where the API process can see it — a workspace link during
development, or a real install (see part 6 for production).

> There is no `EXTENSION_PATH` variable, and no filesystem-path form of this setting. If you find
> one referenced anywhere, it is stale.

Unsetting the variable and restarting removes the extension. There is no hot reload, and no way
to disable a single misbehaving hook: the bag is per package, so unsetting it removes **every**
hook that package provided. Native login cannot be removed this way, so you cannot lock yourself
out.

## 5. Verify it actually loaded

Three independent checks, cheapest first.

### `GET /health`

Unauthenticated. The `extensions_status` field is one of `not_configured`, `loaded`, or
`load_failed`:

```sh
curl -s "localhost:${API_HOST_PORT}/health" | jq .extensions_status
```

`not_configured` means the environment variable never reached the process. `load_failed` means it
did and the load failed — check the boot log for the reason.

### `GET /api/v1/admin/extensions/status`

Authenticated, and the useful one: it returns the loaded manifest itself, plus the native-login
policy state and a clock-skew reading.

```sh
curl -s -H "Cookie: access-token=<session>" \
  "localhost:${API_HOST_PORT}/api/v1/admin/extensions/status" | jq
```

> **Role gotcha.** This route is gated on the organization role **`admin` exactly** — `owner` is
> deliberately *not* treated as admin-equivalent here. If you registered the instance yourself you
> are the `owner` and this route will answer `403`, which looks exactly like a broken extension
> but is not. Use an account with the `admin` role, or grant yourself that role, to check it. It
> also requires an enrolled MFA factor.

### The `/settings/extensions` page

The web UI's view of the same data. It is gated by the same rule — organization role `admin`
exactly, not `owner` — so the same surprise applies.

### Reading a failure

If the load failed, the reason is one of three host-level values, and they do not use the same
words the SDK does:

| Host reason | Means | SDK reason behind it |
|---|---|---|
| `capability_mismatch` | Your `apiVersion` is outside the host's accepted range. | `incompatible-version` |
| `manifest_invalid` | A manifest field is wrong — bad `name`, an illegal optional field, a hook you did not declare. | `invalid-name`, `invalid-manifest-field`, `invalid-db-scope` |
| `import_error` | The module could not be imported, threw at load, or `hooksFactory()` crashed or exceeded the 5-second timeout. | — |

`capability_mismatch` is by far the most common, and it almost always means a hardcoded
`apiVersion`.

## 6. Installing an extension into the production Docker image

This needs its own section because the shipped image is not a normal Node environment.

**What the image is.** The `runner` stage is a `pnpm deploy --prod` snapshot copied to `/app`, and
`npm`/`npx` are **deleted from the image** to shrink its CVE surface. `CMD` runs
`node dist/main.js` directly. The loader resolves your package with Node's own resolution from
`/app/dist/...`, which means it looks in **`/app/node_modules`**.

So the requirement is exactly one thing: **your built package, and its runtime dependencies, must
be present at `/app/node_modules/<your package name>` inside the running container.** Two ways to
achieve that work.

### Option A — a derived image (recommended)

Because the runner has no `npm`, do the install in a separate builder stage and copy the result
in:

```dockerfile
# syntax=docker/dockerfile:1
FROM node:24-alpine AS ext
WORKDIR /build
# Install your extension and everything it needs into a clean tree.
RUN npm install --omit=dev --install-strategy=nested @acme/vault-extension@1.0.0

FROM ghcr.io/nestormata/project-vault/api:X.Y.Z
# /app/node_modules already contains @project-vault/extension-api, which your package resolves
# upward to as a peer dependency.
COPY --from=ext --chown=node:node /build/node_modules/@acme /app/node_modules/@acme
```

Then run that image with `VAULT_EXTENSIONS_PACKAGE=@acme/vault-extension`.

Copy your package's **own** transitive dependencies too if it has any — that is what
`--install-strategy=nested` is for, since it keeps them under your package rather than hoisting
them into a root the `COPY` above would miss. Do **not** copy `@project-vault/extension-api` from
the builder stage: the image already carries the exact copy the host itself uses, and shipping a
second one reintroduces the two-copies problem.

This is the same grafting mechanism the project's own Dockerfile uses to inject its fixture
extensions into an end-to-end image — it copies each fixture's `dist/` and `package.json` into
`/app/deploy/node_modules/<name>` for precisely this reason.

### Option B — a bind mount

For an operator who wants to swap an extension without rebuilding an image, mount a prepared
package directory over the same location:

```yaml
services:
  api:
    image: ghcr.io/nestormata/project-vault/api:X.Y.Z
    environment:
      VAULT_EXTENSIONS_PACKAGE: '@acme/vault-extension'
    volumes:
      - ./extensions/acme-vault-extension:/app/node_modules/@acme/vault-extension:ro
```

The host directory must be a complete, already-built package: a `package.json` whose `main`/
`exports` point at real files, the built `dist/`, and any transitive dependencies under its own
`node_modules/`. Mount it read-only; the container runs the app as the `node` user, which only
needs read access.

This is more fragile than Option A — nothing verifies the mounted tree, and a partially-copied
directory surfaces as `import_error` at boot — but it needs no build step.

### What does *not* work

**`NODE_PATH` does not work.** It is tempting, and it half-works, which is worse than failing
outright. Node's CommonJS resolver still honors `NODE_PATH`, so the loader's manifest read (which
goes through `createRequire().resolve()`) succeeds and finds your package. But the actual load is
a native ESM `import()`, and **ESM resolution ignores `NODE_PATH` entirely** — so the load fails
with `ERR_MODULE_NOT_FOUND`, reported as `import_error`, even though the manifest was read fine.
Verified directly on Node 24; do not use it.

**`RUN npm install` in a single-stage derived image does not work** — `npm` is not in the image.
Use the two-stage form in Option A.

## Guidance for specific hooks

### Capability gates

If you are implementing `capabilityGate`, four things are not obvious from the type signature:

- **Project Vault never caches a gate decision.** Every gated check calls `onCheckCapability()`:
  no per-request memo, no cross-request cache, no TTL. An entitlement downgrade therefore takes
  effect on the very next request, with no restart and no cache flush — but it also means your
  extension owns 100% of its own caching and staleness strategy. If your entitlement source is
  slow or rate-limited, cache on your side of the hook, where you also own the invalidation bound.
- **Gates fail closed.** A gate that throws, rejects, times out, or returns a malformed decision
  produces `403 capability_denied` with `reasonCode: 'gate_unavailable'` (collapsed into the
  route's own uniform failure response on unauthenticated surfaces). Registering a gate is an
  explicit operator declaration that an external policy layer governs the instance; once declared,
  an unanswerable check is an *unknown*, never a permission.
- **`message` is not localized, and cannot be.** `CapabilityGateContext` carries no `locale`
  field, so a user reading Project Vault in another language still sees whatever single language
  you hardcoded. Do not claim otherwise in your own documentation. Project Vault's own fallback
  message is the only localized string in this flow.
- **Quota is out of scope.** This hook answers exactly one question — "may this organization use
  capability X at all?" — never "may this organization create its 51st secret".
  `CapabilityGateContext` carries no resource id, requested count, current usage, or HTTP method,
  so quota simply cannot be expressed through this hook shape.

Also note `GET /api/v1/capabilities`: an authenticated, org-scoped route that reports your gate's
answers as `{ capabilities: Record<CapabilityId, boolean> }` — booleans only. The web app uses it
to cosmetically gate controls. Your `message` and `reasonCode` are never surfaced there; they
reach a user only through an actual denied request's `403`. Do not treat it as a second
distribution channel for your denial text.

### Auth strategies and replay protection

If your `authStrategy` verifies a signed bearer token, its replay guard must be a **database-backed
atomic conditional write** (`INSERT ... ON CONFLICT DO NOTHING`) keyed on the token's unique id.
An in-memory `Set` is not sufficient: each worker or replica gets its own, so the same token can
be replayed once per process, and a restart clears it entirely. The repository's
`mock-envelope-extension` fixture uses an in-memory set deliberately, and says so loudly — it is a
test fixture, not a pattern to copy.

## Recovering from a broken extension

There is deliberately no break-glass switch that disables one hook.

To recover: unset `VAULT_EXTENSIONS_PACKAGE` and restart the API. The instance returns to Project
Vault's default, ungated behavior.

Understand the cost first. `ExtensionHooks` is one bag per package, so this also disables every
other hook that package provides — SSO login, notification channels, UI panels, delivery
providers, and audit fanout. Local login is unaffected and cannot be removed, so you will not be
locked out. This is a wider outage accepted deliberately during an incident, not a like-for-like
swap.

## See also

- [README.md](README.md) — capability, hook, and host-service catalogues.
- [`@project-vault/extension-api` README](https://github.com/nestormata/project-vault/tree/main/packages/extension-api)
  — the contract reference and the generated public-surface snapshots.
- [extension-api-versioning-policy.md](../extension-api-versioning-policy.md) — what counts as a
  breaking change and what compatibility you can rely on.
