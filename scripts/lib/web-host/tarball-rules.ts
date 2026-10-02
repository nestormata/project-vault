// Story 68.2 AC-7: the content rules of the @project-vault/web-host tarball. Pure functions over
// the `npm pack --dry-run --json` file list (and, for the content rules, the files' text), so the
// self-tests can feed them mutated listings. Every rule is general: none names an individual file
// that may be dropped, because the package must never become a curated subset (ADR 0007 M1-M7).
import ts from 'typescript'

/** Entries every tarball must contain. */
export const REQUIRED_ENTRIES = [
  'package.json',
  'LICENSE',
  'README.md',
  'manifests/compatibility.json',
  'vendor/shared/src/index.ts',
  'project.inlang/settings.json',
  'config/svelte.config.js',
  'config/vite.config.js',
  'config/vitest.config.js',
  'src/app.html',
  'src/hooks.server.ts',
  'static/favicon.png',
  'messages/en.json',
  'messages/es.json',
] as const

/** Paths that must never ship: tests, generated output, dev tooling. */
const NOT_SHIPPED: readonly [RegExp, string][] = [
  [/\.(test|spec)\.[cm]?[jt]s$/, 'a test file'],
  [/(^|\/)__tests__\//, 'a __tests__ directory'],
  [/(^|\/)e2e\//, 'Playwright e2e'],
  [/(^|\/)playwright[^/]*$/, 'Playwright config'],
  [/(^|\/)coverage\//, 'coverage output'],
  [/(^|\/)\.svelte-kit\//, 'generated SvelteKit output'],
  [/(^|\/)build\//, 'build output'],
  [/(^|\/)node_modules\//, 'node_modules'],
  [/(^|\/)src\/lib\/paraglide\//, 'generated Paraglide output'],
  [/(^|\/)Dockerfile$/, 'the Dockerfile'],
  [/(^|\/)eslint\.config\.[cm]?js$/, 'lint config'],
  [/^scripts\//, 'dev tooling'],
]

/** Secret- or credential-shaped paths (AC-7 rule 6, Red Team). */
const SECRET_SHAPED: readonly [RegExp, string][] = [
  [/(^|\/)\.env$/, 'an environment file'],
  [/(^|\/)\.env\.[^/]*$/, 'an environment file'],
  [/\.(pem|key|p12|pfx)$/, 'a key or certificate store'],
  [/(^|\/)id_(rsa|ed25519|ecdsa|dsa)$/, 'an SSH private key'],
  [/(^|\/)acme\.json$/, 'a Traefik ACME store'],
  [/(^|\/)credentials\.json$/, 'a credentials file'],
  [/(^|\/)\.npmrc$/, 'an npm config (may hold a token)'],
]

const LIFECYCLE_HOOKS = [
  'preinstall',
  'install',
  'postinstall',
  'prepare',
  'prepublish',
  'preprepare',
  'postprepare',
]

/** Rules 1 and 6 (paths): every shipped path that is a test, generated, tooling or secret-shaped. */
export function forbiddenPathProblems(paths: readonly string[]): string[] {
  return paths.flatMap((path) =>
    [...NOT_SHIPPED, ...SECRET_SHAPED]
      .filter(([pattern]) => pattern.test(path))
      .map(([, what]) => `${path} is ${what} and must not ship`)
  )
}

/** Rule 2: every required entry is present. */
export function missingRequiredEntries(paths: readonly string[]): string[] {
  const shipped = new Set(paths)
  return REQUIRED_ENTRIES.filter((entry) => !shipped.has(entry)).map(
    (entry) => `missing required entry ${entry}`
  )
}

/** Rule 3, the anti-narrowing rule: every tracked non-test file under apps/web/src and
 * apps/web/static (given relative to apps/web) ships. */
export function droppedSourceFiles(
  trackedNonTest: readonly string[],
  paths: readonly string[]
): string[] {
  const shipped = new Set(paths)
  return trackedNonTest
    .filter((path) => !shipped.has(path))
    .map((path) => `${path} is tracked PV source but is not in the tarball`)
}

/** The code tokens of a JS/TS file, comments excluded (the TypeScript scanner skips trivia). */
function codeTokens(text: string): string[] {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text)
  const tokens: string[] = []
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    tokens.push(scanner.getTokenText())
  }
  return tokens
}

const CSS_COMMENT = /\/\*[\s\S]*?\*\//g

/** Rule 4: no `../../` walk into the monorepo outside comments, in the configs and app.css. */
export function monorepoPathProblems(files: ReadonlyMap<string, string>): string[] {
  return [...files].flatMap(([path, text]) => {
    const scanned = path.endsWith('.css') ? [text.replaceAll(CSS_COMMENT, '')] : codeTokens(text)
    return scanned.some((chunk) => chunk.includes('../../'))
      ? [`${path} contains a ../../ path into the monorepo`]
      : []
  })
}

const PRIVATE_KEY_MARKER = /-----BEGIN [A-Z ]*PRIVATE KEY-----/

/** Rule 6 (content): no shipped file embeds private key material. */
export function privateKeyProblems(files: ReadonlyMap<string, string>): string[] {
  return [...files]
    .filter(([, text]) => PRIVATE_KEY_MARKER.test(text))
    .map(([path]) => `${path} contains a PEM private key marker`)
}

/** Rule 6 (manifest): a published package never runs code on the consumer's install. */
export function lifecycleProblems(pkg: Record<string, unknown>): string[] {
  const scripts = (pkg.scripts ?? {}) as Record<string, string>
  return [
    ...('bin' in pkg ? ['package.json declares bin'] : []),
    ...LIFECYCLE_HOOKS.filter((hook) => hook in scripts).map(
      (hook) => `package.json declares a ${hook} script`
    ),
  ]
}
