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
        'ANONYMOUS_ROUTE_PATH_PATTERN',
        'MAX_ANONYMOUS_ROUTE_PATHS',
        'EXTENSION_API_VERSION',
        'HOST_SUPPORTED_EXTENSION_API_RANGE',
        'MAX_UI_PANEL_SLOTS',
        'UI_PANEL_SLOT_NAME_PATTERN',
        'MAX_MODULE_ACTIONS',
        'MODULE_ACTION_NAME_PATTERN',
        'MAX_PANEL_DATA_PATHS',
        'PANEL_DATA_PATH_PATTERN',
        'MAX_NAV_ITEMS',
        'MAX_NAV_ITEM_LABEL_LENGTH',
        'NAV_ITEM_ID_PATTERN',
        'NAV_ITEM_HREF_PATTERN',
        'NAV_ITEM_ICON_TOKENS',
        'MAX_MODULE_DATA_ROUTES',
        'MODULE_DATA_ROUTE_PATH_PATTERN',
        'EXTENSION_THEME_CSS_VARS',
        'ExtensionRegistrationError',
        'isExtensionApiVersionSupported',
        'registerExtension',
        // Story 34.1 — new HostServices.monitoring hook-specific error classes (AC2/AC3/AC7).
        'MonitoringNoAmbientContextError',
        'MonitoringRateLimitedError',
        'MonitoringOrgMismatchError',
        'MonitoringResourceNotFoundError',
        // Story 41.1 — new HostServices.monitoring.createServiceEndpoint hook-specific error class (AC3).
        'MonitoringInvalidServiceEndpointInputError',
        'CredentialSharingNoMachineUserError',
        'CredentialSharingOrgRateLimitedError',
        'CredentialSharingRateLimitedError',
        // Story 36.1 — new HostServices.notificationOriginator hook-specific error classes
        // (AC1/AC3/AC4/AC5).
        'NotificationOriginatorNoAmbientContextError',
        'NotificationOriginatorInvalidParamsError',
        'NotificationOriginatorInvalidRecipientError',
        'NotificationOriginatorRateLimitedError',
        // Story 39.1 — new redirectOrigins allow-list constants for the oauthHandoff hook (AC9).
        'MAX_REDIRECT_ORIGINS',
        'REDIRECT_ORIGIN_PATTERN',
        // Story 56.1 — new scheduledTasks manifest-declaration constants for the scheduledTask
        // hook (AC4).
        'MAX_SCHEDULED_TASKS_PER_EXTENSION',
        'MIN_SCHEDULED_TASK_INTERVAL_MINUTES',
        'SCHEDULED_TASK_HANDLER_NAME',
        'SCHEDULED_TASK_NAME_PATTERN',
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
