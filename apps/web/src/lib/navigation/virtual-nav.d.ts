// Story 68.7 AC-8 — the nav delta virtual module. In PV's own build it comes from
// `apps/web/config/nav-plugins.ts` (`emptyNavModule()`: `export default {}`); in a composed app the
// composition kit's `pvNav()` plugin re-exports the UI pack's `nav.ts`. The kit ships the same
// structural shapes for CM authors (`@project-vault/composition-kit/nav`).
declare module 'virtual:pv-nav' {
  import type { NavDelta } from '$lib/navigation/types.js'

  const delta: NavDelta
  export default delta
}
