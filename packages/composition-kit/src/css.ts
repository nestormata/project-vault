// Design section 9 (theme, M6): the composed app.css gets the shared @source rewritten to the
// vendored path, @source lines for CM code, and the theme @import appended at the END.

/** The marker web-host's `src/app.css` carries (68-2): the next line is the shared `@source`. */
export const SHARED_SOURCE_MARKER =
  '/* @project-vault/web-host: shared-source (the next line is rewritten when packed or composed) */'
/** The shared source glob of the composed app, relative to `src/app.css`. */
export const VENDORED_SHARED_SOURCE_GLOB = '../vendor/shared/src/**/*.ts'
export const CM_SOURCE_LINE = '@source "./lib/_cm/**/*.{svelte,ts}";'

const SOURCE_LINE = /^@source "[^"]*";$/

export interface CssResult {
  css: string
  problems: string[]
  notes: string[]
}

function withTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`
}

/** Locates the marker (never by line number or by the old path), rewrites the line below it. */
function rewriteMarkedSource(css: string): CssResult {
  const lines = css.split('\n')
  const markers = lines.flatMap((line, index) =>
    line.trim() === SHARED_SOURCE_MARKER ? [index] : []
  )
  const vendoredLine = `@source "${VENDORED_SHARED_SOURCE_GLOB}";`
  if (markers.length > 1) {
    return {
      css,
      notes: [],
      problems: ['src/app.css must contain the shared-source marker exactly once'],
    }
  }
  if (markers.length === 0) {
    if (css.split('\n').some((line) => line.trim() === vendoredLine))
      return { css, problems: [], notes: [] }
    return {
      css: `${withTrailingNewline(css)}${vendoredLine}\n`,
      problems: [],
      notes: [
        'src/app.css has no shared-source marker (an overridden app.css?): the vendored shared @source line was added',
      ],
    }
  }
  const target = (markers[0] ?? 0) + 1
  if (!SOURCE_LINE.test(lines.at(target)?.trim() ?? '')) {
    return {
      css,
      notes: [],
      problems: ['src/app.css: the shared-source marker is not followed by an @source "..."; line'],
    }
  }
  return {
    css: lines.map((line, index) => (index === target ? vendoredLine : line)).join('\n'),
    problems: [],
    notes: [],
  }
}

export interface CssOptions {
  /** Whether any CM code was materialized under `src/lib/_cm`. */
  cmCode: boolean
  /** The theme file's `@import` target, relative to `src/app.css` (for example `./lib/_cm/theme.css`). */
  themeImport?: string
}

export function composeAppCss(base: string, options: CssOptions): CssResult {
  const rewritten = rewriteMarkedSource(base)
  if (rewritten.problems.length > 0) return rewritten
  let css = withTrailingNewline(rewritten.css)
  if (options.cmCode && !css.split('\n').some((line) => line.trim() === CM_SOURCE_LINE)) {
    css += `${CM_SOURCE_LINE}\n`
  }
  if (options.themeImport !== undefined) {
    const importLine = `@import "${options.themeImport}";`
    if (css.trimEnd().split('\n').at(-1) !== importLine) css += `${importLine}\n`
  }
  return { css, problems: [], notes: rewritten.notes }
}
