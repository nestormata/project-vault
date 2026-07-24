import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as ExtensionApi from './index.js'

const PACKAGE_JSON_PATH = fileURLToPath(new URL('../package.json', import.meta.url))

describe('index.ts — root-only export surface (AC1, AC2)', () => {
  it('exports defineExtension, registerExtension, and EXTENSION_API_VERSION', () => {
    expect(typeof ExtensionApi.defineExtension).toBe('function')
    expect(typeof ExtensionApi.registerExtension).toBe('function')
    expect(typeof ExtensionApi.EXTENSION_API_VERSION).toBe('string')
  })

  it('exports ExtensionRegistrationError', () => {
    expect(typeof ExtensionApi.ExtensionRegistrationError).toBe('function')
  })

  it("package.json's exports map exposes only the root entry point — no hooks/ subpath (AC2 guard)", () => {
    // PACKAGE_JSON_PATH is a fixed, module-relative sibling-file path derived from
    // import.meta.url, not external input.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const packageJson = JSON.parse(readFileSync(PACKAGE_JSON_PATH, 'utf-8')) as {
      exports: Record<string, unknown>
    }
    expect(Object.keys(packageJson.exports)).toEqual(['.'])
  })
})
