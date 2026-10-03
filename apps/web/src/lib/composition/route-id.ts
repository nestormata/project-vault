// Story 68.6 — Kit route id helpers shared by the header policy and protected paths.

/** `/(app)/(nested)/reports/[id]` -> `/reports/[id]`. A linear split, not a regex (Sonar S8786). */
export function stripRouteGroups(routeId: string): string {
  const kept = routeId
    .split('/')
    .filter((segment) => !(segment.startsWith('(') && segment.endsWith(')')))
  return kept.length > 1 ? kept.join('/') : '/'
}
