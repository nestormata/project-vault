// Story 68.4: the behavior tables of the injection mechanism. PV's own build resolves this module
// to empty tables (`config/injection-plugins.ts`); a composition kit's `pvInject()` generates the real
// ones from the pack's manifest. Per-point modules (`virtual:pv-inject/<name>`) are only ever
// imported by the build transform, so PV's source never names them.
declare module 'virtual:pv-inject-behavior' {
  import type { BehaviorTables } from '$lib/server/composition/inject-behavior.js'
  export const loads: BehaviorTables['loads']
  export const actions: BehaviorTables['actions']
}
