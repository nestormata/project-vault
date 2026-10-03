// Story 68.7 AC-8: the nav delta of this build. In PV's own build `virtual:pv-nav` is `{}` (from
// `apps/web/config/nav-plugins.ts`); in a composed app the composition kit's `pvNav()` re-exports
// CM's `nav.ts`. One code path for both: only this module's content differs.
//
// Deep-frozen at first use, so no component can mutate the shared delta and leak a change into
// another user's request (AC-7). PV's tests pin this module to `{}` (src/lib/test/setup-nav.ts), so
// they stay valid when a composed tree's virtual module holds CM's delta.
import delta from 'virtual:pv-nav'
import { deepFreeze } from './freeze.js'
import type { NavDelta } from './types.js'

export const activeDelta: NavDelta = deepFreeze(delta)
