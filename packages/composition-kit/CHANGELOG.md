# Changelog

## Unreleased

## 0.4.0

- `pvHooks()` Vite plugin (`@project-vault/composition-kit/vite`): generates `virtual:pv-hooks/server`,
  `/universal` and `/client` from the lock for web-host's composable hooks (Story 68-6).
- The composer derives the exact route id of every CM route under `src/routes/(app)/` and records it in
  `contributions.protectedPaths.derived` (a lock without it is read as `derived: []`); validates
  `protectedPaths.add`/`remove` for integrity (malformed entries, an entry in both lists, a redirect
  loop over `/login`, `/register` or `/vault`) and notes the rest (public CM routes, a removed PV
  prefix, a `remove` that matches nothing).
- Reads web-host's new `manifests/hooks-surface.json`: with it, hooks and protected paths are applied
  (the 68-3 "not applied" notes disappear), non-hook exports of a hook file are noted (with a
  "did you mean" hint), a hook in the wrong file is noted, and a contribution to a fully overridden
  hooks file is noted. An older web-host keeps the 68-3 behaviour.
- `--verbose` prints each derived protected route. New types `PvHooksModule`, `PvServerHooksModule`.

## 0.1.0

- First release: the `pv-compose` composer, `defineUiPack()`, the `composition.lock.json` drift lock,
  the compatibility-tuple check and the `pvComposeDev` Vite dev plugin (Story 68-3).
