import { describe, expect, it } from 'vitest'

import * as extensionApi from '../src/index.js'

describe('@project-vault/extension-api public value exports', () => {
  it('keeps the root export surface exact', () => {
    expect(Object.keys(extensionApi).sort()).toEqual([
      'CredentialSharingNoMachineUserError',
      'CredentialSharingOrgRateLimitedError',
      'CredentialSharingRateLimitedError',
      'EXTENSION_API_VERSION',
      'EXTENSION_THEME_CSS_VARS',
      'ExtensionRegistrationError',
      'HOST_SUPPORTED_EXTENSION_API_RANGE',
      'MAX_MODULE_ACTIONS',
      'MAX_MODULE_DATA_ROUTES',
      'MAX_NAV_ITEMS',
      'MAX_NAV_ITEM_LABEL_LENGTH',
      'MAX_PANEL_DATA_PATHS',
      'MAX_REDIRECT_ORIGINS',
      'MAX_SCHEDULED_TASKS_PER_EXTENSION',
      'MAX_UI_PANEL_SLOTS',
      'MIN_SCHEDULED_TASK_INTERVAL_MINUTES',
      'MODULE_ACTION_NAME_PATTERN',
      'MODULE_DATA_ROUTE_PATH_PATTERN',
      'MonitoringInvalidServiceEndpointInputError',
      'MonitoringNoAmbientContextError',
      'MonitoringOrgMismatchError',
      'MonitoringRateLimitedError',
      'MonitoringResourceNotFoundError',
      'NAV_ITEM_HREF_PATTERN',
      'NAV_ITEM_ICON_TOKENS',
      'NAV_ITEM_ID_PATTERN',
      'NotificationOriginatorInvalidParamsError',
      'NotificationOriginatorInvalidRecipientError',
      'NotificationOriginatorNoAmbientContextError',
      'NotificationOriginatorRateLimitedError',
      'PANEL_DATA_PATH_PATTERN',
      'REDIRECT_ORIGIN_PATTERN',
      'SCHEDULED_TASK_HANDLER_NAME',
      'SCHEDULED_TASK_NAME_PATTERN',
      'UI_PANEL_SLOT_NAME_PATTERN',
      'defineExtension',
      'isExtensionApiVersionSupported',
      'registerExtension',
    ])
  })
})
