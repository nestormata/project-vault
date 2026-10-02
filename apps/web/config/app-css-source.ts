// Story 68.2 AC-3: Tailwind's `@source` cannot run code, so the one app.css line that points at
// @project-vault/shared's source is rewritten as text. In PV's monorepo it points at
// packages/shared/src; scripts/pack-web-host.ts rewrites it to the vendored copy in the packed
// web-host, and story 68-3's composer rewrites the same marked line again when it composes. The
// marker comment must sit on the line directly above that single @source line.

export const SHARED_SOURCE_MARKER =
  '/* @project-vault/web-host: shared-source (the next line is rewritten when packed or composed) */'

/** The shared @source glob of a packed web-host, relative to its `src/app.css`. */
export const VENDORED_SHARED_SOURCE_GLOB = '../vendor/shared/src/**/*.ts'

const SOURCE_LINE = /^@source "[^"]*";$/

/** Returns `css` with the marked shared @source line pointing at `glob`. Throws when the marker
 * is missing or repeated, or is not directly followed by one `@source "...";` line. */
export function rewriteSharedSource(css: string, glob: string): string {
  const lines = css.split('\n')
  const markers = lines.flatMap((line, index) =>
    line.trim() === SHARED_SOURCE_MARKER ? [index] : []
  )
  if (markers.length === 0) throw new Error(`app.css has no "${SHARED_SOURCE_MARKER}" marker`)
  if (markers.length > 1)
    throw new Error('app.css must contain the shared-source marker exactly once')
  const target = (markers[0] ?? 0) + 1
  if (!SOURCE_LINE.test(lines.at(target)?.trim() ?? '')) {
    throw new Error('the shared-source marker in app.css is not followed by an @source "..."; line')
  }
  return lines.map((line, index) => (index === target ? `@source "${glob}";` : line)).join('\n')
}
