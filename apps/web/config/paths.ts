// Story 68.2 AC-3: every path the web-host config factories use is computed from where
// @project-vault/web-host is installed, never from a relative walk into PV's monorepo. The same
// code runs from apps/web in PV's workspace and from node_modules/@project-vault/web-host in a
// consumer (CentralizeMe's apps/pv-composed). Both locations resolve the package through its own
// name: Node's package self-reference works because the manifest lists "./package.json" in
// `exports`. createRequire() anchored on import.meta.url is used rather than import.meta.resolve()
// because Vite bundles a config's relative imports into a temporary file, where only
// import.meta.url is rewritten back to the original module location.
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative } from 'node:path'

export const WEB_HOST_PACKAGE = '@project-vault/web-host'
const SHARED_PACKAGE = '@project-vault/shared'

const requireFromHere = createRequire(import.meta.url)

/** The `webHost` block of a web-host manifest. The packed manifest (scripts/pack-web-host.ts)
 * sets `sharedSource` to the vendored copy; PV's workspace manifest leaves it unset. */
export interface WebHostManifest {
  webHost?: { sharedSource?: string }
}

/** Absolute directory of the @project-vault/web-host package (apps/web inside PV's workspace). */
export function webHostRoot(): string {
  return dirname(requireFromHere.resolve(`${WEB_HOST_PACKAGE}/package.json`))
}

function readWebHostManifest(): WebHostManifest {
  return requireFromHere(`${WEB_HOST_PACKAGE}/package.json`) as WebHostManifest
}

/** Absolute directory of @project-vault/shared's TypeScript source: the vendored copy in a packed
 * web-host, or the workspace package's `src/` inside PV's monorepo. */
export function sharedSourceRoot(
  root: string = webHostRoot(),
  manifest: WebHostManifest = readWebHostManifest()
): string {
  const vendored = manifest.webHost?.sharedSource
  if (vendored === undefined) {
    return join(dirname(requireFromHere.resolve(`${SHARED_PACKAGE}/package.json`)), 'src')
  }
  const target = join(root, vendored)
  const inside = relative(root, target)
  if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
    throw new Error(
      `${WEB_HOST_PACKAGE}: webHost.sharedSource must point inside the package, got ${JSON.stringify(vendored)}`
    )
  }
  return target
}

/** Story 68.3: where the composer copies the vendored shared source inside a composed app. */
export function composedSharedSource(composedRoot: string): string {
  return join(composedRoot, 'vendor', 'shared', 'src')
}

/** The three @project-vault/shared import specifiers apps/web uses, mapped to source files. The
 * node-only subpaths come first so they win over the package root. */
export function sharedAliases(
  options: { root?: string; manifest?: WebHostManifest; composedRoot?: string } = {}
): Record<string, string> {
  const source =
    options.composedRoot === undefined
      ? sharedSourceRoot(options.root, options.manifest)
      : composedSharedSource(options.composedRoot)
  return {
    [`${SHARED_PACKAGE}/node-tls`]: join(source, 'node', 'internal-tls-pem.ts'),
    [`${SHARED_PACKAGE}/test-pki`]: join(source, 'node', 'test-pki-test-helpers.ts'),
    [SHARED_PACKAGE]: join(source, 'index.ts'),
  }
}

/** Paraglide compiler options. Messages and the inlang project come from the package (or, for a
 * composed app, from its composed copy); the
 * compiled message modules go into the consuming app's own `src/lib/paraglide`, which is where
 * `$lib/paraglide/...` imports in the (copied) source resolve. */
export function paraglideOptions(appRoot: string = process.cwd(), composedRoot?: string) {
  return {
    // A composed app compiles its own copy of the inlang project (the composer applies the pack's
    // message overlays to it before `paraglide compile`, Story 68.3).
    project: join(composedRoot ?? webHostRoot(), 'project.inlang'),
    outdir: join(appRoot, 'src', 'lib', 'paraglide'),
    // Story 15.1: cookie-based locale, no URL prefixing, so no route changes shape per locale.
    strategy: ['cookie', 'baseLocale'] as ('cookie' | 'baseLocale')[],
    // Story 15.1 Task 4.4: an undefined message key is a TypeScript compile error.
    emitTsDeclarations: true,
  }
}
