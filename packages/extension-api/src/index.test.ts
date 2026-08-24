import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as ExtensionApi from './index.js'

const PACKAGE_JSON_PATH = fileURLToPath(new URL('../package.json', import.meta.url))

describe('index.ts — root-only export surface (AC1, AC2)', () => {
  it('exports exactly the reviewed runtime surface', () => {
    expect(new Set(Object.keys(ExtensionApi))).toEqual(
      new Set([
        'defineExtension',
        'EXTENSION_API_VERSION',
        'HOST_SUPPORTED_EXTENSION_API_RANGE',
        'MAX_UI_PANEL_SLOTS',
        'UI_PANEL_SLOT_NAME_PATTERN',
        'EXTENSION_THEME_CSS_VARS',
        'ExtensionRegistrationError',
        'isExtensionApiVersionSupported',
        'registerExtension',
      ])
    )
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
