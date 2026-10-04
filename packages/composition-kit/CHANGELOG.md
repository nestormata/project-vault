# Changelog

## Unreleased

## 0.9.0

- **Behavior injection for component-scoped region points: the per-route opt-in `hostRoutes`** (Story 69-1,
  Nestor's Q12 option B). A contribution at a region point rendered inside a shared component (for
  example `project.detail.tiles`) may declare `hostRoutes: ['<routeId>#<scope>']` next to its `load` and
  `actions`. The kit then adds the point to each named host route's behavior table (the same
  `<routeId>#<scope>` keys as a standard point), so the load runs with the member's own `RequestEvent` and
  its result reaches the component as `data.__inject['<point>'][i]`. A contribution that does not opt in
  still renders with `data = null`; its load and actions stay recorded in the lock and inert, now with a
  note that names `hostRoutes` and the routes that render the point (never a refusal).
- Integrity only: a host route that does not render the point, a malformed key, a `#layout` host for a
  region only a page renders, or an empty list fails the composition naming the point, the entry and the
  valid routes; a duplicate is dropped silently; opted-in `actions` are refused on a layout host (a layout
  has no form actions) and checked against a default action on the host page server file. When the pack
  overrides a host route's server file, a note says its contribution load runs only if the override calls
  `withInjectedLoad` / `injectActions`.
- Additive: `manifests/injection-points.json` stays `schemaVersion: 1` and gains `hostRoutes` on region
  points. A web-host that predates it keeps components-only injection working and answers an opt-in with
  the "needs a newer web-host" finding; an older kit reads only `name`, `file`, `routeId` and `scope` and
  ignores the field. The lock gains an optional `hostRoutes` per injection (absent when not opted in).

## 0.8.0

- **`pv-verify --only tests` (and the tests step of a full run) now runs with the app's own Vitest
  config** (Story 68-21). It looks for `vitest.config.{ts,mts,cts,js,mjs,cjs}`, then
  `vite.config.*`, at the app root and passes that file as `--config`, so tests over a composed tree see
  the same plugins as the build (`pvHooks()`, `pvNav()`, `pvReplace()`, any plugin of your own). Before,
  the kit generated `.pv-compose/verify.vitest.config.mjs` with no kit plugin, and tests that import
  `virtual:pv-hooks/*`, `virtual:pv-nav` or a replaced module failed against web-host's empty providers.
  The generated config is gone. The step output names the config it used.
- **Breaking for an app without a Vitest or Vite config:** the tests step now fails (exit 1) with
  `no vitest.config.* or vite.config.* in <app>` instead of generating one. Migration: add a
  `vitest.config.ts` such as `export default vitestConfig({ plugins }, { composedRoot })` with the same
  plugin list as `vite.config.ts`. The config must apply the lock's exclusions through
  `vitestConfig({}, { composedRoot })`; when a failing suite is one of `excludedPvTests` the step adds a
  hint saying so. The `excludedPvTests` consistency check is unchanged.

## 0.7.1

- **Fix: `pv-compose` and `pv-verify` did nothing, silently, when launched through a symlink** (Story 68-20,
  CentralizeMe DW-330 finding 1). The `node_modules/.bin/pv-compose` and `node_modules/.bin/pv-verify`
  entries that npm and pnpm create (and a symlinked package directory, as pnpm uses) made the bins
  compare a real-path module URL with the link-path `argv[1]`, so `main` never ran and the exit code was 0. The entry check now compares real filesystem paths, so the bins behave the same through a symlink
  as by their real path (and a path that cannot be resolved is still never mistaken for the entry).
  Consumers no longer need `node --preserve-symlinks-main <kit>/dist/cli.js`; remove that workaround.
  No contract, flag, lock or output change.

## 0.7.0

- **Breaking: the `routeClassifications` authoring shape** (Story 68-16). An entry is now the runtime
  route audit's own entry shape, `{ route: 'GET /api/v1/x', reason, securityOwner?,
compensatingControls?, expiresAfterStory?, revisitBy?, temporary? }`, validated with the same rules
  (route regex, non-empty text, unknown fields and duplicate routes rejected). `method`, `url` and `class`
  are removed; `pv-compose` rejects them with a message naming the migration. Entries are merged sorted by
  `route`, so a lock written under the old shape differs after one recompose (run `pv-compose` once and
  commit the lock). The kit never decides which routes may be public and emits no note for a route Project
  Vault already classifies: the audit fails that duplicate itself.
- `pv-verify --only classifications --out <file>` writes the merged, locked classification entries as the
  JSON array `pnpm --filter @project-vault/api route-audit:runtime --classifications <file>` reads
  (sorted by `route`, deterministic, written atomically, `[]` when the pack has none). It runs the
  preflight first (lock, PV release, tamper check of the generated entries) and writes nothing when it
  fails; no guard or test runs. `--out` is only valid with this step. Use one file per composed variant:
  a stale entry (a route not on that composed API) fails the audit.

## 0.6.0

- Navigation delta (Story 68-7, ADR 0007 M5). New subpath `@project-vault/composition-kit/nav`
  (zero runtime dependencies): `defineNavDelta()` and the operation builders `insert`, `remove`,
  `hide`, `relabel`, `move`, `replace`, `reorder`, with types structurally identical to web-host's
  nav model (a contract test on each side proves it). They build plain objects; nothing limits which
  item a pack may change.
- `pvNav()` Vite plugin (`@project-vault/composition-kit/vite`): resolves `virtual:pv-nav` to a
  re-export of the pack's materialized `nav.ts` (an empty delta without one, or for a lock written
  against an older web-host). A missing lock fails the build.
- `pvReplace()` no longer passes a "leave this id alone" flag to nested resolves in `custom`. Rolldown
  1.2.x can hand one concurrent `this.resolve` call another's `custom`, so the flag sometimes reached
  SvelteKit's import guard on an unrelated import: the guard then recorded PV's file instead of the
  replacement and failed a client import of a replaced `$lib/server` module with "An impossible
  situation occurred" instead of its own "Cannot import ... into code that runs in the browser". The
  plugin now decides from the resolved id alone: an answer that is already a replacement is kept, and
  `pv-original:` maps one back to PV's file.
- With a web-host that ships `manifests/nav-ids.json` with `delta: 1`, the composer reads `nav.ts`
  with the app's TypeScript and records every string-literal id: `navIdsReferenced` (targets and
  anchors operative, except `hide`/`remove` targets), the new `navIdsDeclared` (ids the pack inserts)
  and the informational `navIdsHost` (both optional lock sections, no `lockfileVersion` bump). It
  fails an operative reference to a vanished id, an id used under the wrong surface, and an inserted
  id web-host now defines; it notes new (inherited) web-host ids, hidden/removed vanished ids, every
  non-literal id (with its position) plus a literal/non-literal count, and a change to the footer's
  AGPL source/license links. The "nav delta not applied" note is gone for such a host; an older
  web-host keeps the 68-3 behaviour.

## 0.5.0

- `pv-verify` (Story 68-9), a second command in this package: runs PV's web guards and PV's unit tests
  over a composed tree and reports every finding in one run (preflight, guards, tests; exit `0`, `1`
  for a guard, test or integrity failure, `2` for a usage error). There is no flag that skips,
  disables or ignores a step or a guard. A test guard runs from a scratch copy of web-host's pristine
  guard file and helpers with `PV_GUARD_APP_ROOT` pointing at the real composed app, so a pack that
  overrides a guard cannot blind it; a script guard is imported from web-host.
- New manifest field `guards`: a data module authored with `defineGuardEntries()` holding the pack's
  reviewed carve-outs (browser-storage keys per file, internal-API consumers, route classifications,
  external hrefs). The composer validates it (integrity only, every entry needs a `reason`), maps pack
  paths to composed paths, writes `src/lib/composition/guard-entries.generated.json` and records
  per-section hashes in the lock (`guardEntries`). A stale entry or a release for a file CM did not
  change fails the composition.
- The lock's `excludedPvTests` is now computed from web-host's `manifests/test-subjects.json`: a PV
  test whose subject (a direct import or its sibling) the pack overrode, replaced or removed is
  excluded and listed (sorted, normative for `--check`). Report-only warnings name security-relevant
  exclusions and an exclusion rate above 25%. A pack override of a guard file or its helpers composes
  and is noted in the lock (`guard-file-overridden`).
- Test subjects are walked transitively inside `src/lib` (web-host side; the kit still reads them as
  data), so a PV test that reaches a replaced or overridden module through a component is excluded.
- `pv-verify` without `--pack` fails closed when the lock's `excludedPvTests` differs from what the
  lock's own overrides, removals and replacements imply (extra and missing tests are named). It never
  substitutes the recomputed list, and checks the lock's internal consistency only.
- An older web-host (no guard registry or subject map) still composes; only `pv-verify` fails, naming
  the upgrade. The shared CLI plumbing moved to `cli-shared`.
- `composition.lock.json` is `lockfileVersion` 2 (Story 68-14). `apiRouteOverrides` is now a sorted list of
  `{ method, url, mode, replaceSecurity }` objects: with `--module-pack <dir>` the kit imports the module
  pack's entry (`exports["."]`, else `main`; this runs its top-level code, inside the pack directory, after
  the extension-api tuple check), reads `default.manifest.apiRoutes.override` and never calls
  `hooksFactory()`. Without `--module-pack` the section is empty. `--check` compares the section and names
  it when it drifts. A version 1 lock is still read: recomposing rewrites it as version 2, and `--check`
  on a version 1 lock fails with a version-mismatch message. **Migration:** run `pv-compose` once and
  commit the rewritten lock. `--module-pack` now names the module pack's package root (it already had to
  resolve `@project-vault/extension-api`).

## 0.4.0

- `pvHooks()` Vite plugin (`@project-vault/composition-kit/vite`): generates `virtual:pv-hooks/server`,
  `/universal` and `/client` from the lock for web-host's composable hooks (Story 68-6). A missing
  lock fails the build (no silently empty hooks or protection).
- The composer derives the exact route id of every CM route under `src/routes/(app)/` (pages,
  including a layout-reset `+page@….svelte`, and endpoints) and records it in
  `contributions.protectedPaths.derived` (a lock without it is read as `derived: []`); validates
  `protectedPaths.add`/`remove` for integrity (malformed entries, an entry in both lists, a redirect
  loop over `/login`, `/register` or `/vault`) and notes the rest (public CM routes, a removed PV
  prefix, a `remove` that matches nothing).
- Reads web-host's new `manifests/hooks-surface.json`: with it, hooks and protected paths are applied
  (the 68-3 "not applied" notes disappear), non-hook exports of a hook file are noted (with a
  "did you mean" hint), a hook in the wrong file is noted, and a contribution to a fully overridden
  hooks file is noted. An older web-host keeps the 68-3 behaviour.
- `pvComposeDev` keeps the composed tree across a dev-server restart in the same process (it updates
  it incrementally instead of swapping in a fresh copy).
- `--verbose` prints each derived protected route. New types `PvHooksModule`, `PvServerHooksModule`.

## 0.2.0

- Injection points with behavior injection (Story 68-4, M3). The `pvInject()` Vite plugin
  (`@project-vault/composition-kit/vite`) turns a pack's `injections` into one virtual module per point
  (`virtual:pv-inject/<point>`: the components, statically imported, in `order`) and the
  `virtual:pv-inject-behavior` load and action tables PV's `injectLoad`/`injectActions` read.
- The manifest contract for a contribution is checked for integrity only: `load` and `actions` must be
  named exports, `order` must be finite, a component is not listed twice at one point, and two
  contributions at one point do not export the same action name. A missing injection point never blocks
  a pack: the error says to override the page (M1) or replace the component (M4).
- `composition.lock.json` gains an optional `injections` section (composed paths, `order` filled in,
  and the point's route id and scope); `--check` treats it as normative, and a lock without it is read
  as having none. `lockfileVersion` stays 1.
- The kit reads `routeId` and `scope` from web-host's `injection-points.json` (additive registry
  fields); it fails closed on a duplicate point name, and fails only a pack that declares `load` or
  `actions` against a registry that lacks them.
- A web-host release that changes route files (this one adds injection points to every PV page) changes
  the hash of every file a pack overrides: the next composition reports drift until `--accept-host`
  reconciles it. That is the intended signal.
- Component and module replacement (M4, Story 68-5): `pvReplace()` in `@project-vault/composition-kit/vite`
  shadows a module by its resolved absolute path in the client and SSR (and in vitest), and
  `pv-original:<specifier>` reaches PV's own file for a wrap. `pv-compose` writes the generated
  `.pv-compose/replacements.json` map and a types-only `_pv-original.d.ts`; a `.js`/`.jsx`/`.mjs` key now
  matches the `.ts`/`.tsx`/`.mts` file. Informational lock notes per replacement from web-host's
  `manifests/component-index.json` (`@pv-stable` is a signal, never a gate). New export
  `@project-vault/composition-kit/pv-original` (fallback `.svelte` typing).

## 0.1.0

- First release: the `pv-compose` composer, `defineUiPack()`, the `composition.lock.json` drift lock,
  the compatibility-tuple check and the `pvComposeDev` Vite dev plugin (Story 68-3).
