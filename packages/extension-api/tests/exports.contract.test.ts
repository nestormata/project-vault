import { describe, expect, it } from 'vitest'

import * as extensionApi from '../src/index.js'

describe('@project-vault/extension-api public value exports', () => {
  it('keeps the root export surface exact', () => {
    expect(Object.keys(extensionApi).sort()).toEqual([
      'EXTENSION_API_VERSION',
      'ExtensionRegistrationError',
      'HOST_SUPPORTED_EXTENSION_API_RANGE',
      'defineExtension',
      'isExtensionApiVersionSupported',
      'registerExtension',
    ])
  })
})
