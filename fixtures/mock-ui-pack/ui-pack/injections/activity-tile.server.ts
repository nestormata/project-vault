// Story 69.1: a contribution `load` at the region point `dashboard.home.activity`, run through the
// dashboard route's behavior table (the pack opted in with `hostRoutes`). The dashboard page server
// file is the pack's own override, which keeps its `withInjectedLoad` call: that call is what makes
// this load run, and it is the pack's responsibility (PV's guards do not check CM files).
export const load = () => ({ marker: 'mock-ui-pack:m3-dashboard-region-load' })
