import type { InjectionPointExtras } from '$lib/components/composition/injection-points.js'

// Story 69.3: what the endpoint list page hands each of its region components (the point's own props
// beyond the route id and params) plus the page's `__inject` map, which a region forwards to its point.
export type EndpointListRegionProps = InjectionPointExtras<'project.service-endpoints.header'> & {
  data?: Record<string, readonly unknown[]>
}
