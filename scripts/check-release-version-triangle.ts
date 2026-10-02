#!/usr/bin/env tsx
/**
 * The release "version triangle" gates (Story 68.2 AC-9/AC-10), one script for both npm releases:
 *
 *   tsx scripts/check-release-version-triangle.ts extension-api --tag 3.25.0
 *     tag == packages/extension-api/package.json version == compiled dist EXTENSION_API_VERSION
 *   tsx scripts/check-release-version-triangle.ts web-host --tag 1.4.0
 *     tag == staged web-host package.json version == compatibility manifest pvRelease, and the
 *     manifest's apiImageTag names that same version
 *
 * Prints the compared values as JSON and exits 1 on any mismatch.
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { assertVersionTriangle, readExtensionApiVersions } from './lib/version-triangle.js'

// import.meta.url rather than import.meta.dirname: extension-api-release.yml also runs this on Node 20.
const STAGE_DIR = fileURLToPath(new URL('../.web-host-pack', import.meta.url))

export async function extensionApiCorners(tag: string): Promise<Record<string, string>> {
  const versions = await readExtensionApiVersions({ compiled: true })
  return { tag, package: versions.package, compiled: versions.manifest }
}

export function webHostCorners(tag: string): Record<string, string | undefined> {
  // Loaded through module resolution (a JSON require), not a file read of a computed path.
  const requireStaged = createRequire(join(STAGE_DIR, 'package.json'))
  const pkg = requireStaged('./package.json') as { version?: string }
  const manifest = requireStaged('./manifests/compatibility.json') as {
    pvRelease?: string
    apiImageTag?: string
  }
  return {
    tag,
    package: pkg.version,
    pvRelease: manifest.pvRelease,
    apiImageTag: manifest.apiImageTag?.split(':').at(-1),
  }
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { tag: { type: 'string' } },
  })
  const [target] = positionals
  if (values.tag === undefined || (target !== 'extension-api' && target !== 'web-host')) {
    throw new Error(
      'usage: check-release-version-triangle.ts <extension-api|web-host> --tag <version>'
    )
  }
  const corners =
    target === 'extension-api' ? await extensionApiCorners(values.tag) : webHostCorners(values.tag)
  process.stdout.write(`${JSON.stringify(corners)}\n`)
  assertVersionTriangle(corners)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
