/** Removes any trailing `/` characters. Written as a plain scan rather than
 * `str.replace(/\/+$/, '')` — Sonar (typescript:S8786) flags unbounded quantifiers anchored at
 * the end of a regex as superlinear-backtracking risk, and there is no need for a regex here. */
export function stripTrailingSlashes(url: string): string {
  let end = url.length
  while (end > 0 && url[end - 1] === '/') end--
  return url.slice(0, end)
}
