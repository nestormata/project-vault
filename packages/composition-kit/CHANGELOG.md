# Changelog

## Unreleased

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
