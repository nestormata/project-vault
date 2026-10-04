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
| `uiPanelSlots`, `moduleActions` | Optional, and only legal alongside `ui-panel`. Part of the legacy runtime UI extension API (HTML panels; deprecated and frozen; see [Module actions and ActionResult](#module-actions-and-actionresult)). |
| `moduleDataRoutes` | Optional, and not gated on any capability (`registerExtension()` deliberately does not require `ui-panel` for it). Mounts real `GET` routes on Project Vault's own API router under `/api/v1/extensions/data`. `GET`-only, under a fixed prefix, so it adds routes but cannot override or wrap existing ones. It does not belong to the panel API. It is deprecated and frozen (no new features or fixes; kept until removed; security issues resolved by replacement or removal) in its own right; first-party API route composition is the planned forward path. |
| `navItems` | Optional, and not gated on any capability. Adds append-only navigation entries to Project Vault's shell. It does not belong to the panel API. It is deprecated and frozen (no new features or fixes; kept until removed; security issues resolved by replacement or removal) in its own right; build-time UI composition navigation is the planned forward path. |
| `dbScope` | Optional and operator-approved: a request for a separate least-privilege database handle. |
| `apiRoutes` | Optional (since 3.27.0), and not gated on any capability. Adds API routes at any URL and overrides (`replace`) or wraps (`wrap`) Project Vault's own API routes, all inside Project Vault's security pipeline. Declarations are data here; handlers, schemas and hook functions go in `hooks.apiRoutes.routes`. Validation is integrity only: no URL prefix, count cap, capability or allowlist. See [API routes (`apiRoutes`)](#api-routes-apiroutes) and, for the global hooks and error handlers (since 3.29.0), [App-level behaviour](#app-level-behaviour-apiroutesapp). |

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

### Module actions and ActionResult

> This section describes the legacy runtime UI extension API (HTML panels), which is deprecated
> and frozen: it gets no new features or fixes, it is kept until it is replaced or removed, and
> security issues in it are resolved by replacing or removing the affected functionality. It
> covers `uiPanel`/`onRenderPanel`,
> `UIPanelResult` HTML strings, `uiPanelSlots`, `moduleActions` and `data-pv-action`, host DOMPurify
> sanitization, and the `/extensions/panels/[slot]/[...subpath]` route, which renders
> host-sanitized panel HTML inline. A separate build-time composition tier for a first-party,
> trusted UI package is the planned forward path and is not built yet; see
> [UI extension tiers](README.md#ui-extension-tiers).

A panel first renders through your `uiPanel` hook. When the user clicks a control in it, Project
Vault dispatches the action to your `moduleAction` hook's `onAction(context, request)` and
re-renders the panel from the `ActionResult` it returns.

- **`context` is a `ModuleActionContext`.** Its organization and identity (`context.orgId`,
  `context.identity`) are supplied by the host from the authenticated session, never taken from
  the request body.
- **`request` is a `ModuleActionRequest`.** `request.action` is the parsed body; only
  `request.action.kind` is read by the host, and it must be in your manifest's `moduleActions`
  allowlist, or the host rejects the request before `onAction` runs.

What the caller gets for each `outcome`:

| `outcome`           | Status | `message` shown                                  | `html` rendered         |
| ------------------- | ------ | ------------------------------------------------ | ----------------------- |
| `ok`                | 200    | yes, only when no `html` is returned             | yes, replaces the panel |
| `validation_failed` | 400    | yes (required)                                   | yes, replaces the panel |
| `denied`            | 403    | **never**, a fixed generic message is shown      | yes, replaces the panel |
| `conflict`          | 409    | yes (a generic "Conflict" if omitted)            | yes, replaces the panel |
| `error`             | 500    | n/a (no field), a fixed generic message is shown | yes, replaces the panel |

- **Non-empty `html` is sanitized by the host (DOMPurify) and replaces the panel container on
  every outcome**, failures included; an empty string is ignored. On a failure the status line
  below the panel still shows the message from the table. Sanitization removes scripts and unsafe
  markup, not information.
- **`error.html` is shown to end users.** It must never contain exception text, stack traces or
  database detail. Project Vault cannot detect such text; you are responsible for it.
- **Scope your html yourself.** Render only data that belongs to `context.orgId` and
  `context.identity`. Project Vault does not inspect, cache or re-scope `html`.
- **Only a returned result carries html.** A hook that throws, times out or returns a malformed
  result (including a non-string `html`) degrades to a bare `error` with no html, and the host
  never forwards thrown error text.
- **Version note:** non-`ok` `html` is declared from extension API 3.24.0 and rendered from
  Project Vault 1.3.0. Hosts up to 1.2.x silently drop it, so do not rely on it for essential
  information when your extension may run on an older host.

Return a typed literal per outcome, and keep error html static:

```ts
const moduleAction: ModuleAction = {
  async onAction(context, request): Promise<ActionResult> {
    if (request.action.kind !== 'share.revoke') {
      return { outcome: 'validation_failed', message: 'Unknown action.' }
    }
    try {
      const share = await revokeShare(context.orgId, request.action)
      if (share === undefined) {
        return { outcome: 'denied', html: renderDenied() }
      }
      return { outcome: 'ok', html: renderSharePanel(context.orgId, share) }
    } catch {
      return { outcome: 'error', html: renderError() } // fixed text, nothing from the caught value
    }
  },
}

// Don't: spreading a result object skips TypeScript's excess-property checks and attaches the
// panel html to whatever outcome `result` carries, failures included:
//   return { ...result, html: renderSharePanel(context.orgId, model) }
```

### Auth strategies and replay protection

If your `authStrategy` verifies a signed bearer token, its replay guard must be a **database-backed
atomic conditional write** (`INSERT ... ON CONFLICT DO NOTHING`) keyed on the token's unique id.
An in-memory `Set` is not sufficient: each worker or replica gets its own, so the same token can
be replayed once per process, and a restart clears it entirely. The repository's
`mock-envelope-extension` fixture uses an in-memory set deliberately, and says so loudly — it is a
test fixture, not a pattern to copy.

### Delivery providers: delivery semantics

A `deliveryProvider`'s `send()` receives `queueRowId` and `attemptNumber` (since 3.25.0).
`queueRowId` is the idempotency key: it is the same on every retry of one notification and never
reused, so forward it as your provider's idempotency key (for example
`Idempotency-Key: pv-nq-<queueRowId>`). Project Vault calls `send()` again for the same
`queueRowId` only after an earlier call rejected. Once `send()` resolves, or while its outcome is
unknown (the process stopped during the call, or the result could not be recorded), Project Vault
never calls it again for that notification and marks it `failed` instead. If your `send()` can
reject after the message was actually accepted (a timeout, for example), deduplicating on
`queueRowId` is what keeps the retry from sending twice. `attemptNumber` is for logs and metrics
only; never put it in the idempotency key.

### API routes (`apiRoutes`)

`apiRoutes` (since `@project-vault/extension-api` 3.27.0) lets an extension register real API
routes on Project Vault's API router and override or wrap Project Vault's existing API routes. It
replaces the deprecated `moduleDataRoutes`. Every route runs inside Project Vault's own security
pipeline: session authentication, organization role, MFA, platform-operator check, rate limit,
capability gate, the row-level-security (RLS) request transaction, audit and post-commit
callbacks.

Declare the routes in the manifest and put the functions in the hooks, keyed by `"<METHOD> <url>"`:

```ts
import { z } from 'zod/v4'
import { EXTENSION_API_VERSION, type ExtensionManifest } from '@project-vault/extension-api'

const manifest: ExtensionManifest = {
  name: 'com.acme.docs',
  apiVersion: EXTENSION_API_VERSION,
  capabilities: [],
  apiRoutes: {
    add: [{ method: 'GET', url: '/api/v1/acme/documents', options: { security: { minimumRole: 'member', writeAuditEvent: false } } }],
    override: [{ method: 'GET', url: '/api/v1/projects/:projectId', mode: 'wrap', schema: 'extend' }],
  },
}

const hooksFactory = () => ({
  apiRoutes: {
    routes: {
      'GET /api/v1/acme/documents': { handler: async (ctx) => ({ data: { orgId: ctx.auth.orgId } }) },
      'GET /api/v1/projects/:projectId': {
        handler: async (_ctx, _req, _reply, next) => {
          const pv = (await next()) as { data: object }
          return { data: { ...pv.data, acmeTiles: [] } }
        },
        schema: { response: { 200: z.object({ data: z.looseObject({ acmeTiles: z.array(z.string()) }) }) } },
      },
    },
  },
})
```

**Adding a route (`add`).** Any method (`GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE`,
`OPTIONS`) at any URL, including outside `/api/v1`. `options.security` takes the same fields as
Project Vault's own routes (`requireAuth`, `requireOrgScope`, `minimumRole`, `allowedRoles`,
`requireMfa`, `requirePlatformOperator`, `writeAuditEvent`, `rateLimit`, `capability`); omitted
fields take Project Vault's defaults (authenticated, organization-scoped, viewer or above, 60
requests per minute per user, default audit on mutating methods). An added route's default
rate-limit bucket and default audit event type are its full `METHOD url`. Adding a route at a URL
and method Project Vault already serves fails the boot: declare it under `override` instead. An
added `OPTIONS` route is more specific than the CORS plugin's `OPTIONS *`, so your handler answers
that URL's preflight.

**Overriding a route (`override`).** The key must match the route Project Vault registers,
including its parameter names (`/api/v1/projects/:projectId`, not `/api/v1/projects/:id`). A
trailing slash is ignored.

- `mode: 'replace'`: your handler runs in place of Project Vault's business handler. Everything
  before it is still Project Vault's: authentication, role, rate limit (Project Vault's bucket),
  MFA, capability gate and the transaction.
- `mode: 'wrap'`: your handler gets `next()`, which runs Project Vault's handler with the same
  context and resolves with its result. You may call it more than once (Project Vault's handler,
  and its writes, run again in the same transaction) or never (then it behaves like `replace`).
  `next()` is valid only until your handler's promise settles; a call after that rejects with
  `apiRoutes wrap next() called after the handler settled: <METHOD> <url>`. If Project Vault's
  handler sent the reply itself (for example a `422`), `next()` resolves with `reply.sent === true`
  and you must not send again.
- `schema: 'replace'` uses your schema verbatim; `schema: 'extend'` merges per part (`params`,
  `querystring`, `body`, `headers`, and `response` per status code), yours winning for the parts
  you supply. Without one, Project Vault's response schema still serializes your result, so
  unknown fields are stripped.
- `hooks: { prepend, append }` places your `onRequest`, `preValidation`, `preHandler` and
  `onSend` functions before or after Project Vault's own route hooks of that phase.
- A `GET` override also answers the automatic `HEAD` route. Declare an explicit `HEAD` override
  to answer `HEAD` differently.
- Raw Project Vault routes (health, metrics, vault init/unseal, the session login routes and their
  `405` stubs, the swagger-ui routes) can be overridden too; their handler signature is
  `(req, reply)` and `(req, reply, next)` for `wrap`. The API docs routes exist only when API docs
  are enabled (`ENABLE_API_DOCS`).

**`replaceSecurity: true`.** The entry's own `security` then replaces the route's security
wholesale, and Project Vault still builds the pipeline from it, so
`security: { requireAuth: false, rateLimit: false }` gives an unauthenticated, unthrottled handler
whose context is `{}`. On a raw route it builds the secure pipeline around your handler (your
handler then has the `(ctx, req, reply)` signature). It is recorded, never refused: one `warn`
boot log line (`extension.api_route.replace_security`) per route, and the
`GET /api/v1/admin/extensions/status` `apiRoutes` list. Only the route's own security is replaced.
Context-level hooks of the route's plugin (for example the per-IP limiter on the CLI login routes)
and app-wide hooks (vault guard, helmet, CORS) still run. Without `replaceSecurity`, a `security`
key on an override fails the manifest, so a typo can never silently weaken a route. For the same
reason every `security` object (on an `add` or an override) is checked for unknown keys and value
types (`minimumRol`, `requireMfa: 'yes'` or `minimumRole: 'Admin'` fail the manifest), and two
entries that differ only by a trailing slash are one route (a duplicate).

**Handler context.** An authenticated, organization-scoped route gets
`ctx = { auth, tx, onPostCommit, audit }`. `ctx.tx` is Project Vault's request transaction (a
drizzle `PgTransaction` at runtime, with `app.current_org_id` set, so RLS limits every query to
the caller's organization); await every query on it. Your own tables are reached through
`host.getDbHandle()`, a separate pool and transaction, so a write there is **not** atomic with
Project Vault's transaction: write it inside `ctx.onPostCommit` (after Project Vault committed) or
make it idempotent and compensate. A request that holds `ctx.tx` while it waits on
`getDbHandle()` uses two connections; size the pools for it. Public routes get `ctx = {}`.

**Capabilities.** An `apiRoutes` entry's own `security.capability` (on an added route, or on an
override with `replaceSecurity: true`) may be any id, including your own capability ids that
Project Vault does not know. Project Vault passes it unchanged to your registered
`capabilityGate` hook, which permits or denies it; a denial answers PV's `403 capability_denied`
with your `reasonCode`. With no `capabilityGate` registered, an id outside Project Vault's own
`CapabilityId` set is denied (`reasonCode: 'unknown_capability'`, fail closed), while a Project
Vault id behaves as on PV's own routes (no gate, no check). The gate step runs only on
authenticated routes, so a `capability` on a `requireAuth: false` entry fails the boot (it could
never be enforced) instead of being ignored. An override
without `replaceSecurity` keeps Project Vault's own security, and PV's own routes keep refusing an
unknown id at boot. The status endpoint lists each entry's `capability`.

**Schemas.** Supply a schema Project Vault's compilers accept: today a Zod 4 schema per part,
including `zod/v4` from zod 3.25 and later. Project Vault checks every schema part while the API
boots; one it cannot use fails the boot with the route key.

**Errors and sessions.** These are API routes. Like Project Vault's own, an expired session gets a
JSON `401`, not a redirect, so call them with `fetch` from your pages. A browser-navigable
experience (a download link, an OAuth callback page) belongs in a composed page or `+server`
endpoint.

**Boot failures.** A missing override target, an undeclared collision or a rejected schema fails
the boot (`startup.failed` with `extension.reason` `extension_api_route_drift`,
`extension_api_route_collision` or `extension_api_route_schema_rejected`), even when
`VAULT_EXTENSIONS_REQUIRED` is false: by then routes were already changed and cannot be
un-registered, so the API cannot start with a partially applied extension. A failure before any
route is touched (import, manifest, version negotiation, `hooksFactory()`) stays fail-open unless
`VAULT_EXTENSIONS_REQUIRED=true`, which turns every load failure (and an unset
`VAULT_EXTENSIONS_PACKAGE`) into a boot failure. Composed deployments set it.

**Observability.** One `info` line `extension.api_routes.applied` lists every added and
overridden route key with its mode and flags. Every request an extension route answers carries a
`pvRoute` binding (`{ override: 'replace' | 'wrap' }` or `{ added: true }`) in Project Vault's
request logs. An extension route whose rate-limit bucket equals a Project Vault route's logs one
`extension.api_route.shared_default_key` warning; set `rateLimit.key` to separate them.

#### App-level behaviour (`apiRoutes.app`)

`apiRoutes.app` (since `@project-vault/extension-api` 3.29.0) changes what applies to **every**
request: global hooks, the error handler and the not-found handler, with the same `wrap`/`replace`
model as routes. A pack without `app` loads exactly as before; there is no prefix, capability or
allowlist.

```ts
const manifest: ExtensionManifest = {
  name: 'com.acme.docs',
  apiVersion: EXTENSION_API_VERSION,
  capabilities: [],
  apiRoutes: {
    app: {
      hooks: { prepend: ['onRequest'], append: ['onSend'] },
      errorHandler: 'wrap',
      notFoundHandler: 'wrap',
    },
  },
}
// hooksFactory() returns:
// { apiRoutes: { app: {
//     hooks: { onRequest: myOnRequest, onSend: myOnSend },
//     errorHandler: (error, req, reply, next) => (error instanceof AcmeError ? reply.status(409).send({ code: 'acme_conflict' }) : next()),
//     notFoundHandler: (req, reply, next) => (req.url.startsWith('/acme/') ? reply.status(404).send({ code: 'acme_not_found' }) : next()),
// } } }
```

- **Phases.** `onRequest`, `preValidation`, `preHandler` and `onSend` (the request phases; `onRoute`,
  `onRegister`, `onReady` and `onClose` are not accepted). A phase in `prepend` and `append` runs the same
  functions at both positions.
- **Where the hooks sit.** `prepend` hooks run before Project Vault's own app-wide hooks (structured
  logging, the vault guard), **including while the vault is sealed**: a prepended `onRequest` hook runs on a
  sealed vault before the guard's `503`. `append` hooks run after Project Vault's last app-wide hook and
  before its route plugins: right after the vault guard when `vaultGuardEnabled` is true, and in that same
  (empty) slot when it is false, so an appended hook never runs on a request the guard already answered.
  Both reach every route, including routes in encapsulated plugins.
- **No tenant context.** App-level hooks run outside any request transaction: they receive no `ctx.tx` and
  no organization scope. Do not touch tenant tables from a hook without your own scope (`getDbHandle()`).
- **Error and not-found handlers.** `replace` makes your function the handler for every error (or every
  unknown route), Project Vault's own errors included; `wrap` gives it a `next()` that runs Project Vault's
  handler with the same error, so `validation_error`, `internal_error` and the `429` shapes stay
  byte-identical unless you change them. Project Vault's own not-found output is Fastify's default 404
  body, reproduced unchanged.
- **A throwing handler never leaks.** If your error or not-found function throws or rejects, Project Vault
  logs one `extension.api_route.app_handler_failed` error (route key and error class only, never the
  message or stack) and answers with its own handler and the **original** error.
- **Recording.** One `extension.api_route.app_override` warning per change at boot,
  `extension.api_routes.applied` lists them under `app`, and `GET /api/v1/admin/extensions/status` returns
  `apiRoutes.app` (`errorHandler`, `notFoundHandler`, `hooks.prepend`, `hooks.append`; declaration data
  only).

#### Verifying a composed API: the runtime route audit and the composed spec

Two tools boot the real `createApp()` with your extension, with no database (the loader's DB steps are
stubbed; the admin database URL variable still has to be set to any well-formed URL, as for
`generate-spec`):

```bash
# Prove every route on the composed API is secureRoute-built or classified. Exit 0 pass, 1 an audit failure
# or an extension that did not load, 2 a usage or classification-file error.
pnpm --filter @project-vault/api route-audit:runtime --extension <package> [--classifications <file>]

# Write your composed OpenAPI document. Both flags together; --out must not resolve to PV's own spec.
pnpm --filter @project-vault/api generate-spec --extension <package> --out <path>
```

The audit uses a root route collector and `app.ready()`: it sends no request and opens no port. A route is
accepted when `secureRoute()` built it or when a classification names it (`METHOD /full/url`, prefix
included): Project Vault's own table (`PUBLIC_ROUTE_EXEMPTIONS` plus explicit entries for the 405 stubs,
swagger-ui, `OPTIONS *` and `GET /status`; a HEAD route Fastify derives from a classified GET needs no
entry) and the optional `--classifications` file. The file is a JSON array of `{ "route", "reason" }`
entries (the optional `securityOwner`, `compensatingControls`, `expiresAfterStory`, `revisitBy` and
`temporary` fields of Project Vault's table are allowed; any other field is rejected). Extension and
Project Vault entries are reviewed under the same rules: the audit never decides which routes may be
public. An unclassified route, a duplicate key and a **stale** classification (a key for a route that does
not exist) all fail, naming the key. The report is sorted and holds no absolute path or env value.

A UI pack (composition kit 0.7.0+) authors its classifications in `guards.routeClassifications` with the same
entry shape and rules, and `pv-verify --app <dir> --only classifications --out <file>` writes the file this
audit reads (one file per composed variant, never a shared union, regenerated whenever the pack changes: a
stale entry fails). An entry that restates a Project Vault classification is an error; the audit must run
with API docs enabled, which its CLI forces.

`generate-spec --extension` writes the composed document atomically; a boot failure or a package that
does not load exits 1 and leaves the old `--out` untouched. The committed `packages/shared/openapi.json`
stays Project Vault-only: `--out` spellings that resolve to it (relative, `..`, `//`, a symlink or a hard
link) exit 2 without writing.

## Recovering from a broken extension

There is deliberately no break-glass switch that disables one hook.

To recover: unset `VAULT_EXTENSIONS_PACKAGE` and restart the API. The instance returns to Project
Vault's default, ungated behavior.

Understand the cost first. `ExtensionHooks` is one bag per package, so this also disables every
other hook that package provides — SSO login, notification channels, UI panels, delivery
providers, and audit fanout. Local login is unaffected and cannot be removed, so you will not be
locked out. This is a wider outage accepted deliberately during an incident, not a like-for-like
swap.

Unsetting the package does not remove UI that a first-party UI package has had composed into the
web image at build time (the planned composition tier, not built yet). Once that tier exists,
recovering such an instance also means rolling the composed web image back in lockstep with the
extension package.

## See also

- [README.md](README.md) — capability, hook, and host-service catalogues.
- [`@project-vault/extension-api` README](https://github.com/nestormata/project-vault/tree/main/packages/extension-api)
  — the contract reference and the generated public-surface snapshots.
- [extension-api-versioning-policy.md](../extension-api-versioning-policy.md) — what counts as a
  breaking change and what compatibility you can rely on.
