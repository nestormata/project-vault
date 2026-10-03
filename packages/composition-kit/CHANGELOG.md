# Changelog

## Unreleased

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
