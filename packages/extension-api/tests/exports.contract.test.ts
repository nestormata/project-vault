import { describe, expect, it } from 'vitest'

import * as extensionApi from '../src/index.js'

describe('@project-vault/extension-api public value exports', () => {
  it('keeps the root export surface exact', () => {
    expect(Object.keys(extensionApi).sort()).toEqual([
      'EXTENSION_API_VERSION',
      'EXTENSION_THEME_CSS_VARS',
      'ExtensionRegistrationError',
      'HOST_SUPPORTED_EXTENSION_API_RANGE',
      'MAX_MODULE_ACTIONS',
      'MAX_MODULE_DATA_ROUTES',
      'MAX_NAV_ITEMS',
      'MAX_NAV_ITEM_LABEL_LENGTH',
      'MAX_PANEL_DATA_PATHS',
      'MAX_UI_PANEL_SLOTS',
      'MODULE_ACTION_NAME_PATTERN',
      'MODULE_DATA_ROUTE_PATH_PATTERN',
      'NAV_ITEM_HREF_PATTERN',
      'NAV_ITEM_ICON_TOKENS',
      'NAV_ITEM_ID_PATTERN',
      'PANEL_DATA_PATH_PATTERN',
      'UI_PANEL_SLOT_NAME_PATTERN',
      'defineExtension',
      'isExtensionApiVersionSupported',
      'registerExtension',
    ])
  })
})
