// The "version triangle" check, shared by the extension-api release workflow and the web-host pack
// (Story 68.2 AC-9/AC-10). Every named value must be present and identical; the error names them
// all so the release log shows which corner is wrong.

/** Throws `version triangle mismatch: {...}` unless every value is the same non-empty string. */
export function assertVersionTriangle(values: Record<string, string | undefined>): string {
  const distinct = new Set(Object.values(values))
  const [only] = [...distinct]
  if (distinct.size !== 1 || only === undefined || only === '') {
    throw new Error(`version triangle mismatch: ${JSON.stringify(values)}`)
  }
  return only
}

export interface ExtensionApiVersions {
  /** packages/extension-api/package.json `version`. */
  package: string
  /** `EXTENSION_API_VERSION`, from the TypeScript source or the compiled `dist`. */
  manifest: string
}

/** Reads both extension-api version corners. `compiled` reads the built `dist/manifest.js` (what a
 * release publishes) instead of the TypeScript source. */
export async function readExtensionApiVersions(
  options: { compiled?: boolean } = {}
): Promise<ExtensionApiVersions> {
  const packageJson = (await import('../../packages/extension-api/package.json', {
    with: { type: 'json' },
  })) as { default: { version: string } }
  const manifest = (
    options.compiled
      ? await import('../../packages/extension-api/dist/manifest.js')
      : await import('../../packages/extension-api/src/manifest.ts')
  ) as { EXTENSION_API_VERSION: string }
  return { package: packageJson.default.version, manifest: manifest.EXTENSION_API_VERSION }
}

/** The extension-api version both corners agree on; throws naming both values when they differ. */
export async function extensionApiVersion(options: { compiled?: boolean } = {}): Promise<string> {
  return assertVersionTriangle({ ...(await readExtensionApiVersions(options)) })
}
