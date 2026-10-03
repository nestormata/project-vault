// Story 68.9 AC-7: the Tailwind source-boundary rules for `src/app.css`, valid on PV's own tree and
// on a composed one. The line constants are duplicated from `config/app-css-source.ts` and the kit's
// composer (a shipped file cannot import outside `src`, and PV never imports the MIT kit); tests on
// both sides pin the copies.
export const IMPORT_LINE = '@import "tailwindcss" source(none);'
export const APP_SOURCE_LINE = '@source "./**/*.{svelte,ts}";'
export const MONOREPO_SHARED_LINE = '@source "../../../packages/shared/src/**/*.ts";'
export const VENDORED_SHARED_LINE = '@source "../vendor/shared/src/**/*.ts";'
export const CM_SOURCE_LINE = '@source "./lib/_cm/**/*.{svelte,ts}";'

function escapes(line: string): boolean {
  return /"(?:\.\.\/|\/|[^"]*node_modules)/.test(line.slice('@source '.length))
}

/** Problems with a composed or PV `src/app.css`; `cmCode` is whether `src/lib/_cm` exists. */
export function tailwindBoundaryProblems(css: string, cmCode: boolean): string[] {
  const lines = css.split('\n').map((line) => line.trim())
  const sources = lines.filter((line) => line.startsWith('@source '))
  const count = (wanted: string): number => sources.filter((line) => line === wanted).length
  const problems: string[] = []
  if (!lines.includes(IMPORT_LINE)) {
    problems.push(
      `app.css must contain ${IMPORT_LINE} (Tailwind may never auto-scan the repository)`
    )
  }
  if (count(APP_SOURCE_LINE) !== 1) {
    problems.push(
      `app.css must contain ${APP_SOURCE_LINE} exactly once (found ${count(APP_SOURCE_LINE)})`
    )
  }
  if (count(MONOREPO_SHARED_LINE) + count(VENDORED_SHARED_LINE) !== 1) {
    problems.push(
      'app.css must hold exactly one shared @source line (the monorepo line or the vendored one)'
    )
  }
  const allowed = new Set([
    APP_SOURCE_LINE,
    MONOREPO_SHARED_LINE,
    VENDORED_SHARED_LINE,
    ...(cmCode ? [CM_SOURCE_LINE] : []),
  ])
  for (const line of sources.filter((entry) => !allowed.has(entry))) {
    problems.push(
      escapes(line)
        ? `${line} points outside the app root (source escapes the app root)`
        : `${line} is not a source line the composer or PV writes`
    )
  }
  const lastSource = lines.findLastIndex((line) => line.startsWith('@source '))
  const earlyImport = lines.findIndex(
    (line, index) => index < lastSource && line.startsWith('@import ') && line !== IMPORT_LINE
  )
  if (earlyImport !== -1) problems.push('the theme @import must come after every @source line')
  return problems
}
