# Changelog

## Unreleased

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
