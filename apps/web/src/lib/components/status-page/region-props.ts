import type { InjectionPointExtras } from '$lib/components/composition/injection-points.js'

// Story 69.3: what the status page admin screen hands each of its region components (the point's own
// props beyond the route id and params) plus the page's `__inject` map, which a region forwards to its
// point. The link region has its own props and never receives these (it must not see more than flags).
export type StatusPageRegionProps = InjectionPointExtras<'project.status-page.header'> & {
  data?: Record<string, readonly unknown[]>
}
