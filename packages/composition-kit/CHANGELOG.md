# Changelog

## Unreleased

## 0.5.0

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
