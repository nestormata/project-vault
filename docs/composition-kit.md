# The composition kit (`@project-vault/composition-kit`)

The kit is Project Vault's half of build-time UI composition (ADR 0007, design sections 2, 3, 4, 9
and 11). [`@project-vault/web-host`](web-host-package.md) publishes PV's web source; the kit composes
a consumer's own `src/`-shaped UI pack onto it **before compilation**, locks what it changed, and
fails the build on drift or on a version mismatch. PV's own `apps/web` build, image and tests never
run kit code and do not change.

- **Licence:** MIT (`packages/composition-kit`). `web-host` and the rest of PV stay
  AGPL-3.0-or-later. The kit reads `web-host` as **data** (files on disk). It never imports, copies
  or vendors AGPL source. `pnpm check-composition-kit-boundary` (in `make ci-inner`) fails when a kit
  file imports `apps/web`, `@project-vault/web-host` or any workspace package, when a kit file is a
  byte copy of an `apps/web` file, or when a production dependency of the kit is not permissively
  licensed (MIT, ISC, BSD, Apache-2.0, 0BSD, BlueOak).
- **First consumer:** CentralizeMe's `apps/pv-composed`. The kit is generic: its vocabulary is
  `pv-ui` and `pack`, and its README example uses `@acme/pv-ui`.
- **Nothing here narrows M1-M7.** The composer has no allowlist of overridable paths and never rejects
  a declared override, removal, replacement or injection. Every validation checks integrity only.

## The pipeline

```text
pv-compose  ->  paraglide compile  ->  svelte-kit sync  ->  svelte-check  ->  guards and tests  ->  vite build
```

1. **Tuple check, before any copying** (below).
2. **Copy** `web-host`'s `src/`, `static/`, `messages/`, `project.inlang/` and `vendor/` into the app
   root as regular files (never symlinks or hardlinks). Each generated directory carries a
   `.pv-compose-generated` header (and no `.gitignore` inside: Tailwind's scanner honours one and would
   skip every composed file, so the app's own `.gitignore` lists them). The kit owns these directories and
   refuses to replace one that has no header. It also refuses to run when the app root is a filesystem
   root, a home directory, has no `package.json`, or overlaps `web-host` or the pack.
3. **Overlay** the pack's `src/` and `static/`. A pack file on an existing PV path is an *override* and
   must be declared in `routes.overrides` with the PV file's `hostSha256`; an undeclared collision
   fails (an integrity check against accidental shadowing, resolved by declaring it). A pack file on a
   new path is an *addition* (M2) and needs no declaration.
4. **Removals** (`routes.remove`): a route id such as `/(app)/extensions/panels` removes its whole
   subtree, including files PV adds there later; a `src/...` or `static/...` entry removes that file
   or directory. Removals are recorded with their hash. A changed removed file is informational. A
   removal that matches nothing is informational too (the end state already holds).
5. **Materialize** CM code that is not at a route path under `src/lib/_cm/**` (`$cm`), or
   `src/lib/server/_cm/**` when it is server-only. The set is the transitive closure of the files the
   manifest names plus every pack file outside `src/` and `static/` that an overlay file imports.
   Relative imports are rewritten by AST (the app's own `typescript` and `svelte/compiler`, taken as
   peer dependencies). Kit's own server-only guard then rejects a client import of server-only CM code.
6. **CSS and messages.** The theme `@import` is appended to the **end** of the composed
   `src/app.css`; PV's shared `@source` is rewritten (located by its marker comment) to the vendored
   copy; CM files get `@source` lines. A pack `messages/<locale>.json` overrides PV's own message keys
   and adds locales PV lacks. CM's own strings are not merged (ADR 0007 decision 7); a key PV does not
   define is reported as a note.
7. **Lock.** `composition.lock.json` is written atomically.

`compose()` is a pure `plan()` (reads, computes, writes nothing) plus an `apply()` that builds the tree
in a `0700` temp directory next to the target and swaps it in, so a failure leaves the previous tree
intact. `--dry-run` and `--check` use the plan only.

## The manifest and the lock

See the [package README](../packages/composition-kit/README.md) for the manifest shape and the CLI.
`composition.lock.json` is committed. It holds hashes and paths only (no CM or PV file content), has
sorted keys and arrays and no timestamps or absolute paths, and validates against
[`composition.lock.schema.json`](../packages/composition-kit/schema/composition.lock.schema.json).
It records the compatibility tuple, every override (`hostSha256`, `cmSha256`, `story`, `hostVersion`),
addition, removal and replacement, the materialized files, the contributions later stories apply
(hooks, nav, theme, protected paths), the injection points used, and informational notes. The sections
`excludedPvTests` and `apiRouteOverrides` are written empty: Story 68-9 fills the first, Stories
68-3/68-8 (whichever lands second) wire the second.

## Hooks, header policy and protected paths

Story 68-6 (design §8). A pack contributes to every SvelteKit hook without replacing PV's hooks
files, changes PV's security-header policy through the same contribution, and gets its `(app)`
routes protected like PV's. A full-file override of `src/hooks.server.ts`, `src/hooks.ts` or
`src/hooks.client.ts` stays allowed (M1); contributions are the normal path, not the only one.
Nothing here limits what a pack may contribute: every validation is integrity only.

### Wiring

```ts
// pv-ui.manifest.ts
hooks: { server: './hooks.server.ts', universal: './hooks.universal.ts', client: './hooks.client.ts' },
protectedPaths: { add: ['/public-cm'], remove: ['/(app)/cm-area/callback'] },

// vite.config.ts and vitest.config.ts of the composed app
import { pvHooks } from '@project-vault/composition-kit/vite'
export default viteConfig({ plugins: [pvHooks({ appRoot })] }, { appRoot, composedRoot: appRoot })
```

`pvHooks()` (`enforce: 'pre'`) generates `virtual:pv-hooks/server`, `/universal` and `/client` from
`composition.lock.json`: each re-exports the materialized CM file's namespace as `hooks` (empty when
the pack has no such file), and the server module also exports the protected-path data. web-host
ships its own empty provider for PV's build, and it **refuses to build a composed tree without
`pvHooks()`** (`composed tree detected but pvHooks() from @project-vault/composition-kit/vite is not
in the plugin list`), so a composed image can never silently ship without CM hooks or derived
protection. In dev a change to the lock's hooks or protected-path contribution restarts the dev
server (SvelteKit caches the server hooks behind a module-level `init_promise`).

The server hook file is materialized under `src/lib/server/_cm/**`, so Kit's own server-only guard
rejects a client import of it. Exports that are not hooks are ignored and noted (`hookLabel` is not a
SvelteKit server hook; not composed), a near miss gets "did you mean `handle`?", and a hook in the
wrong file (`reroute` in the server file) gets "move it to hooks.universal". If the pack also
overrides the hooks file a contribution targets, the contribution is not composed (a note says so).

### The contract: chain entry or `wrap`

Every hook is a chain entry ("CM first, then PV") or `{ wrap: (pv) => replacement }`. When neither
PV nor the pack defines a hook, the composed export is `undefined`, so SvelteKit's own default runs.
Entries are called as plain functions. A throw or rejection propagates exactly as from PV's own hook.

| Hook (file) | Chain entry | Chain semantics | `wrap` receives |
|---|---|---|---|
| `handle` (server) | `Handle`, or `{ before?, after?, wrap? }` | `[...before, wrap ? wrap(pv) : pv, ...after]` with `sequence()` semantics | PV's handle |
| `handleFetch` (server) | `HandleFetch` | CM runs; its `fetch` is PV's `handleFetch` bound to the real fetch | PV's, or a passthrough |
| `handleError` (server, client) | `HandleServerError` / `HandleClientError` | CM then PV, both awaited; CM's result unless `undefined` | PV's, or one returning `undefined` |
| `handleValidationError` (server) | `HandleValidationError` | CM first; the first non-`undefined` result | PV's, or one returning `undefined` |
| `init` (server, client) | `ServerInit` / `ClientInit` | CM then PV, awaited in order | PV's, or a no-op |
| `reroute` (universal) | `Reroute` | CM first; a string wins, `undefined` falls through to PV | PV's, or one returning `undefined` |
| `transport` (universal) | `Transport` | `{ ...pv, ...cm }`; the same key on both sides fails at start-up | PV's, or `{}` |

**Where `handle` entries run (Q10).** `before` entries run outermost, before PV: there is no
`locals.user` and no Paraglide locale yet, and they run for anonymous requests to protected paths
too. `after` entries run inside PV, after PV's redirects and immediately before Kit's `resolve`:
they see `locals.user` and `getLocale()`, and never run for a request PV redirected. `wrap(pv)`
replaces PV's handle in place. Three examples:

```ts
// 1. A request id on every response (before).
export const handle = { before: [async ({ event, resolve }) => {
  const response = await resolve(event)
  response.headers.set('x-request-id', crypto.randomUUID())
  return response
}] }
// 2. Tenant-scoped data for signed-in users only (after).
export const handle = { after: [({ event, resolve }) => {
  event.locals.tenant = tenantOf(event.locals.user)
  return resolve(event)
}] }
// 3. Full replacement of PV's handle (wrap): call pv zero, one or several times.
export const handle = { wrap: (pv) => async (input) => (shouldSkip(input.event) ? input.resolve(input.event) : pv(input)) }
```

PV composes `handle` with its own `composeHandles()`: Kit `sequence()`'s semantics (forward
pre-processing, reverse post-processing, innermost-first `transformPageChunk`, first-wins `preload`
and `filterSerializedResponseHeaders`) without Kit's request store, proven by a differential test
against the real `sequence()`. Two documented differences: no per-handle OpenTelemetry span, and
`getRequestEvent()` inside a handle returns the request-level event, not one passed through
`resolve(otherEvent)`.

**Error logging (Q7).** PV defines no `handleError`, so in PV's build Kit's default logs every
server error. Once a pack contributes `handleError`, that function is the export and Kit's default no
longer runs, as in any SvelteKit app that defines `handleError`. Re-add logging in your own entry if
you want it:

```ts
export const handleError = ({ error, status }) => { console.error(status, error) }
```

### Header policy

PV's security headers are one data policy (`PV_HEADER_POLICY` in `$lib/security/header-policy.ts`):
`defaults` plus exclusive `rules` (the first matching rule's headers replace the defaults). A rule
matches `{ exact }`, a raw `{ startsWith }`, a Kit `{ routeId }` or a `{ test }` predicate. The
composition sets the resolved headers with **one** `event.setHeaders` call per request, before the
first handle. Kit applies `setHeaders` only to responses that went through `resolve`, so redirects a
handle returns carry no policy headers (as before 68-6).

A server hook file changes it with `export const headerPolicy = (pv) => ({ ...pv, ... })`. The
returned policy is final: it may add, change or remove rules and defaults. It is validated
(well-formed names and values, no CR/LF/NUL, no `set-cookie`, unique rule ids, one matcher key) and
deep-frozen. It is **never refused**: `describeHeaderPolicyDelta(PV_HEADER_POLICY, composed)` records
every added, changed and removed header and rule (a `test` predicate rule is reported as
`(opaque match)`). PV's policy applies to CM UI exactly as to PV UI: no rule is keyed on where a
route came from.

- **Change headers through `headerPolicy`, not `event.setHeaders` in a handle:** a handle that sets a
  name the policy already set makes Kit throw `"<name>" header is already set` on that request.
- **Route-level `setHeaders` conflicts fail at start-up (Q2).** `/shares/[token]` and
  `/external-shares/[token]` set `Referrer-Policy` in their `load`. A policy that would also set
  `referrer-policy` there fails with a message naming the routes; exclude those paths in a rule, or
  override those pages (M1).
- **The legacy extension-panel CSP is outside the policy** (Nestor, 2026-10-02): paths under
  `/extensions/panels/` keep exactly their frozen panel headers, and no contribution reaches them,
  until Story 68-11 retires the panel.
- **Start-up failures are caught in CI.** web-host ships `composed-hooks-init.test.ts`, which runs
  every composition over the virtual modules: a bad policy, a hook of the wrong shape or a transport
  collision fails the composed tree's test run before it can crash-loop a server.

### Protected paths

PV's protected prefixes are data (`PV_PROTECTED_PREFIXES`, segment-prefix: `/settings` covers
`/settings` and `/settings/...`). `isProtectedRequest` is the one gate, used by both the vault
readiness check and the anonymous redirect. A request is protected when its pathname matches a
prefix, when Kit's matched route id (with `(group)` segments removed) matches a prefix, or when the
route id is one the composer derived. The route-id test closes two bypasses: a `reroute` that maps an
unprotected URL onto a protected route, and a percent-encoded URL (`/%73ettings/...`), which Kit
decodes for matching but not in `event.url.pathname`.

The composer **derives the exact route id** of every CM route under `src/routes/(app)/` (an addition
or an override with a `+page.svelte`, `+page.ts`, `+page.server.ts` or `+server.ts`), so CM pages,
their data requests, their form actions and their `+server` endpoints are gated by the hook. That
matters because Kit runs no layout load for `+server` and runs a form action before any load.
CM routes outside `(app)` are public by design and listed in a note.

- `protectedPaths.add` adds path prefixes; `protectedPaths.remove` removes a prefix (PV's or an
  added one) or a derived route id, for example an OAuth callback. Removing a PV prefix is allowed
  and noted prominently. An entry that matches nothing is a note.
- Integrity failures: an `add` entry not starting with `/`, containing `?` or `#`, or ending with `/`;
  the same entry in `add` and `remove`; any protected prefix or derived route that covers `/login`,
  `/register` or `/vault` (a guaranteed redirect loop).
- The lock records `contributions.protectedPaths = { add, remove, derived: [{ routeId, urlPattern }] }`.
  A lock written before 68-6 has no `derived` and is read as `derived: []`. Run with `--verbose` to
  print each derived route.
- **Remote functions are not gated by protected paths (Q9).** `$app/server` `query`/`form`/`command`
  are served under `/_app/remote/...` with no route id; call `requireUser(getRequestEvent().locals)`
  inside them.

An older web-host without `manifests/hooks-surface.json` keeps the 68-3 behaviour: the files are
materialized and the lock records them, with notes that hooks and protected paths are not applied.

## Drift and the upgrade flow

Drift **fails** the build when an overridden or replaced PV file changed, when an injection point CM
uses vanished and CM did not cause it by overriding the page that contained it, or when an operative
nav id vanished. It is **informational** when a removed file changed, PV added an item CM inherits, or
a vanished id is only hidden or removed.

The lock stores only hashes, so the report prints, for each drifted file, **CM's file against the NEW
PV file** (a unified diff: what your override now differs from). With `--previous-host <dir>` it also
prints the true old-to-new PV diff. `hostVersion` in the lock records the PV release each hash was
accepted at, so a reconciliation can fetch the old tarball from npm.

Upgrade flow (design section 11):

1. Bump the PV versions (`@project-vault/web-host`, the kit, and the Kit/Svelte/Vite/TypeScript
   versions the new tuple names).
2. `pv-compose` lists every drifted file in one run.
3. A reconciliation story updates each override or replacement.
4. `pv-compose --accept-host <path>` records the new hash (repeat the flag for several files). It
   writes the **lock only**, never CM's hand-written manifest: the manifest's `hostSha256` is the
   initial declaration and the lock is the authoritative accepted state. It refuses a path that is not
   declared and does nothing when the hash is already accepted.
5. Run the mechanism tests and CM's own end-to-end tests.

`pv-compose --check` (CI) fails when the committed lock differs from the regenerated one in the
normative sections (`compatibility`, `overrides`, `additions`, `replacements`, `materialized`,
`contributions`, `injectionPointsUsed`, `navIdsReferenced`, `apiRouteOverrides`, and the removals'
paths). `notes` and the removed files' hashes never fail it.

## The version tuple

`web-host`'s `manifests/compatibility.json` names the PV release, the `extension-api` version, the
kit version (`kitVersion`), the exact Kit, Svelte, Vite and TypeScript versions and the API image
tag. The composer compares the **installed** versions it resolves from the app root (never declared
ranges), `@project-vault/composition-kit`'s own installed version, the manifest's `host.pvRelease`,
and, with `--module-pack <dir>`, the module pack's `@project-vault/extension-api`. It also requires
every `web-host` runtime dependency to be a runtime dependency of the app at the identical version
(`adapter-node` externalizes only `dependencies`). All mismatches are reported in one run. There is no
flag to skip the check: a skippable gate is the allowlist pattern this project rejects.

## Releasing

The kit has its own semver (`packages/composition-kit/package.json`, mirrored by `src/version.ts` and
asserted equal by `pnpm exec tsx scripts/check-release-version-triangle.ts composition-kit --tag <v>`).
It publishes from the same PV `vX.Y.Z` tag as `web-host`, in the `publish-kit` job of
`.github/workflows/web-host-release.yml`, which **runs before `publish`**: `web-host`'s compatibility
manifest names the kit version, so the kit must be on npm first (`publish` refuses a real upload when
it is not). Always dist-tag `next`, OIDC provenance, the `npm-publish` environment, Node 24 leg only;
a PV release that does not change the kit does not re-publish it. A PV prerelease tag (`v1.4.0-rc.1`)
publishes `web-host@1.4.0-rc.1` but the kit keeps its own version.

Maintainer-only, never done by CI or an agent (Story 68-13): the npm trusted-publisher entry for the
kit, a bootstrap publish if npm needs the package to exist first, the `Composition kit integration`
required check, the first real publish, and promotion to `latest`.

## Verifying

- `pnpm --filter @project-vault/composition-kit test` runs the kit's unit tests with coverage.
- `make composition-kit-integration` (CI job `Composition kit integration`) packs the real `web-host`
  and the kit, installs them from the tarballs into a fresh directory outside the repository under
  `env -i`, composes a small pack, then runs paraglide compile, `svelte-kit sync`, `svelte-check
  --fail-on-warnings`, the shipped unit tests and `vite build`, boots the built server and asserts over
  HTTP and in the built CSS. Variants prove that `svelte-check` fails on a lying `./$types`, that
  Kit's server-only guard rejects a client import of materialized server-only code (and accepts the
  same import from `+page.server.ts`), and that the Vite dev plugin mirrors a pack edit, an added
  route and a deleted override.
