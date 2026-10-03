const NUMERIC = /^(?:0|[1-9]\d*)$/
const PRERELEASE = /^[0-9A-Za-z.-]+$/

/** An exact semver version (`1.4.0`, `8.3.1-rc.0`), never a range. */
export function isExactVersion(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const dash = value.indexOf('-')
  const core = (dash === -1 ? value : value.slice(0, dash)).split('.')
  const prerelease = dash === -1 ? undefined : value.slice(dash + 1)
  return (
    core.length === 3 &&
    core.every((part) => NUMERIC.test(part)) &&
    (prerelease === undefined || PRERELEASE.test(prerelease))
  )
}
