/**
 * AC1/AC2 — this is the ONLY import path extension authors use: `@project-vault/extension-api`.
 * Never `@project-vault/extension-api/hooks/...` — the package's `package.json#exports` map only
 * declares the root entry point (guarded by `index.test.ts`'s structural assertion and this
 * file's own review checklist item below).
 *
 * Review checklist for future changes to this file: adding a new hook type or manifest export
 * belongs here as a re-export from `src/hooks/*` or `src/*` — never add a corresponding
 * `hooks/*` subpath to this package's `exports` map in `package.json`.
 */
export type { AuthResult, AuthStrategy } from './hooks/auth-strategy.js'
export type { NotificationChannel, NotificationPayload } from './hooks/notification-channel.js'
export type { UIPanel, UIPanelContext, UIPanelResult } from './hooks/ui-panel.js'
export type {
  ActionResult,
  ModuleAction,
  ModuleActionContext,
  ModuleActionRequest,
} from './hooks/module-action.js'
export type {
  CapabilityDecision,
  CapabilityGate,
  CapabilityGateContext,
} from './hooks/capability-gate.js'
export type {
  AuditEventSourceHost,
  AuditEventSourceWriteInput,
  AuditEventSourceWriteResult,
} from './hooks/audit-event-source.js'
export type {
  OrgAuthorizationCheckContext,
  OrgAuthorizationHost,
  OrgAuthorizationOutcome,
} from './hooks/org-authorization.js'
export type { EphemeralStateHost } from './hooks/ephemeral-state.js'
export type {
  ProjectCreateDecision,
  ProjectCreatePolicy,
  ProjectCreatePolicyContext,
} from './hooks/project-lifecycle.js'

export type { HostServices } from './host-services.js'
export type {
  ExtensionDbHandle,
  ExtensionDbOperation,
  ExtensionDbScopeEntry,
  ExtensionDbUnavailableReason,
  ExtensionRuntimeContext,
} from './db-access.js'

export type { ExtensionThemeCssVar } from './theme-contract.js'
export { EXTENSION_THEME_CSS_VARS } from './theme-contract.js'

export type { ExtensionCapability, ExtensionManifest } from './manifest.js'
export {
  EXTENSION_API_VERSION,
  HOST_SUPPORTED_EXTENSION_API_RANGE,
  MAX_MODULE_ACTIONS,
  MAX_PANEL_DATA_PATHS,
  MAX_UI_PANEL_SLOTS,
  MODULE_ACTION_NAME_PATTERN,
  PANEL_DATA_PATH_PATTERN,
  UI_PANEL_SLOT_NAME_PATTERN,
  defineExtension,
} from './manifest.js'

export type { ExtensionRegistrationErrorReason } from './errors.js'
export { ExtensionRegistrationError } from './errors.js'

export type { ExtensionHooks } from './register-extension.js'
export { isExtensionApiVersionSupported, registerExtension } from './register-extension.js'
