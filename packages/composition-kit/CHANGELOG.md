# Changelog

## Unreleased

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
