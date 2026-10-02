// Story 68.2 AC-8 (Nestor 2026-10-02, code review option a): where the out-of-monorepo consumer
// fixture gets @project-vault/extension-api. web-host depends on PV's exact extension-api version,
// and feature PRs bump that version before it is published, so a registry-only fixture would turn
// CI red for every PR until the extension-api release. Rules:
//   - the exact version is on npm -> install it from the registry;
//   - npm answers E404 -> install a tarball packed from packages/extension-api, unless the run is
//     registry-only (the release workflow sets WEB_HOST_FIXTURE_REGISTRY_ONLY=1), which fails;
//   - any other npm view outcome (network, auth, a killed process, unexpected output) fails, so a
//     flaky registry never silently switches the fixture to workspace code.

export const EXTENSION_API_PACKAGE = '@project-vault/extension-api'
/** Set to `1` by web-host-release.yml: the release must build against the published version. */
export const EXTENSION_API_REGISTRY_ONLY_ENV = 'WEB_HOST_FIXTURE_REGISTRY_ONLY'

export interface NpmViewResult {
  status: number | null
  stdout: string
  stderr: string
}

export type ExtensionApiSource = { kind: 'registry' } | { kind: 'workspace'; reason: string }

/** Decides the extension-api source from `npm view <package>@<version> version`. Throws when the
 * fixture must fail instead. */
export function extensionApiSource(
  version: string,
  view: NpmViewResult,
  options: { registryOnly: boolean }
): ExtensionApiSource {
  const spec = `${EXTENSION_API_PACKAGE}@${version}`
  if (view.status === 0 && view.stdout.trim() === version) return { kind: 'registry' }
  if (view.status !== 0 && view.status !== null && /\bE404\b/.test(view.stderr)) {
    if (options.registryOnly) {
      throw new Error(
        `${spec} is not on npm, and this run requires the registry version ` +
          `(${EXTENSION_API_REGISTRY_ONLY_ENV}=1). Publish extension-api ${version} first.`
      )
    }
    return { kind: 'workspace', reason: 'npm view answered E404' }
  }
  throw new Error(
    `could not confirm whether ${spec} is on npm (npm view exit ${String(view.status)}):\n` +
      `${view.stdout}${view.stderr}`
  )
}

/** The one log line the fixture prints when it uses the workspace tarball. */
export function extensionApiFallbackLine(version: string, reason: string): string {
  return (
    `fixture: ${EXTENSION_API_PACKAGE}@${version} is not on npm yet (${reason}), so the consumer ` +
    'installs a tarball packed from packages/extension-api instead. PR and local runs only: the ' +
    `release sets ${EXTENSION_API_REGISTRY_ONLY_ENV}=1 and requires the registry version.`
  )
}
