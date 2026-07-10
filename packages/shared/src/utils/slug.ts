/** Trims leading/trailing `-` without a regex — Sonar (typescript:S8786) flags the
 * `/^-+|-+$/g` / `/-+$/g` alternatives as superlinear-backtracking risk. Shared by every
 * slug-generating helper (org names, project names) so the two didn't hand-restate an identical
 * implementation (jscpd zero-duplication gate, `make ci`). */
export function trimHyphens(value: string): string {
  let start = 0
  let end = value.length
  while (start < end && value[start] === '-') start++
  while (end > start && value[end - 1] === '-') end--
  return value.slice(start, end)
}
