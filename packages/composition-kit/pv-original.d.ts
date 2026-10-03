// @project-vault/composition-kit/pv-original: fallback typing for `pv-original:` imports (Story 68.5).
//
// `pv-compose` writes an exact `declare module 'pv-original:<specifier>'` for every file the pack
// replaces, and a declared module always wins over the patterns below. This file only covers a
// `.svelte` import of a file nothing replaced (identity): a wildcard module cannot name a per-file
// type, so such a component accepts any props. `svelte-check` types PV's own call sites against
// PV's original file, not against CM's replacement: CM's own tests cover the replacement's contract.
declare module 'pv-original:*.svelte' {
  import type { Component } from 'svelte'
  const component: Component<Record<string, unknown>>
  export default component
}
