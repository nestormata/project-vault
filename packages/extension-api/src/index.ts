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
export type {
  ProjectAuthorizationCheckContext,
  ProjectAuthorizationHost,
  ProjectAuthorizationOutcome,
} from './hooks/project-authorization.js'
export type { EphemeralStateHost } from './hooks/ephemeral-state.js'
export type {
  MonitoringAlertType,
  MonitoringApplyHealthCheckResultParams,
  MonitoringApplyHealthCheckResultResult,
  MonitoringCleanupProjectMonitoringParams,
  MonitoringCleanupProjectMonitoringResult,
  MonitoringCreateServiceEndpointParams,
  MonitoringDeleteServiceEndpointParams,
  MonitoringDisableStatusPageParams,
  MonitoringDisableStatusPageResult,
  MonitoringEnableStatusPageParams,
  MonitoringEnableStatusPageResult,
  MonitoringGetHealthDashboardDataParams,
  MonitoringHealthDashboard,
  MonitoringHealthDashboardProjectEntry,
  MonitoringHealthDashboardServiceEntry,
  MonitoringHealthDashboardSummary,
  MonitoringListServiceEndpointsForSchedulingParams,
  MonitoringRegenerateStatusPageTokenParams,
  MonitoringRegenerateStatusPageTokenResult,
  MonitoringServiceEndpointForScheduling,
  MonitoringServiceEndpointRecord,
  MonitoringServiceEndpointStatus,
  MonitoringUpdateServiceEndpointPauseStateParams,
  MonitoringUpdateServiceEndpointPauseStateResult,
  PvMonitoringHost,
} from './hooks/monitoring.js'
export {
  MonitoringInvalidServiceEndpointInputError,
  MonitoringNoAmbientContextError,
  MonitoringOrgMismatchError,
  MonitoringRateLimitedError,
  MonitoringResourceNotFoundError,
} from './hooks/monitoring.js'
export type {
  ProjectArchivedContext,
  ProjectArchiveNotifier,
  ProjectCreateDecision,
  ProjectCreatePolicy,
  ProjectCreatePolicyContext,
} from './hooks/project-lifecycle.js'
export type {
  ModuleDataRequestContext,
  ModuleDataResult,
  ModuleDataRouteHandler,
} from './hooks/module-data.js'
export type {
  DeliveryProvider,
  DeliveryProviderSendPayload,
  DeliveryProviderSendResult,
  DeliveryStatusEvent,
  DeliveryStatusValue,
} from './hooks/delivery-provider.js'
export type {
  NotificationOriginatorChannel,
  NotificationOriginatorEnqueueForOrgParams,
  NotificationOriginatorEnqueueParams,
  NotificationOriginatorEnqueueResult,
  NotificationOriginatorHost,
} from './hooks/notification-originator.js'
export type { OAuthHandoffHooks, OAuthHandoffRedirectResult } from './hooks/oauth-handoff.js'
export type {
  PublicRouteHooks,
  PublicRouteRequest,
  PublicRouteResult,
} from './hooks/public-route.js'
export type { ExtensionRequestStateHostService } from './hooks/extension-request-state.js'
export type {
  CredentialShareCreationErrorStatus,
  CredentialShareSummary,
  CredentialSharingCreateExternalShareParams,
  CredentialSharingCreateExternalShareResult,
  CredentialSharingFindShareByTokenResult,
  CredentialSharingHost,
  CredentialSharingListParams,
  CredentialSharingListResult,
  CredentialSharingOrgListParams,
  CredentialSharingRevealResult,
  CredentialSharingRevokeShareParams,
  CredentialSharingRevokeShareResult,
  CredentialSharingShareRecord,
  CredentialSharingShareStatus,
  CredentialSharingSupersedeSharesForRotationParams,
  CredentialSharingSupersedeSharesForRotationResult,
} from './hooks/credential-sharing.js'
export {
  CredentialSharingNoMachineUserError,
  CredentialSharingOrgRateLimitedError,
  CredentialSharingRateLimitedError,
} from './hooks/credential-sharing.js'
export type { ScheduledTaskContext, ScheduledTaskHooks } from './hooks/scheduled-task.js'
export {
  NotificationOriginatorInvalidParamsError,
  NotificationOriginatorInvalidRecipientError,
  NotificationOriginatorNoAmbientContextError,
  NotificationOriginatorRateLimitedError,
} from './hooks/notification-originator.js'

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

export type {
  ExtensionCapability,
  ExtensionManifest,
  ExtensionNavItem,
  ModuleDataRouteDeclaration,
  ScheduledTaskDeclaration,
} from './manifest.js'
export type { NavItemIconToken } from './manifest.js'
export {
  ANONYMOUS_ROUTE_PATH_PATTERN,
  EXTENSION_API_VERSION,
  HOST_SUPPORTED_EXTENSION_API_RANGE,
  MAX_ANONYMOUS_ROUTE_PATHS,
  MAX_MODULE_ACTIONS,
  MAX_MODULE_DATA_ROUTES,
  MAX_NAV_ITEM_LABEL_LENGTH,
  MAX_NAV_ITEMS,
  MAX_PANEL_DATA_PATHS,
  MAX_REDIRECT_ORIGINS,
  MAX_SCHEDULED_TASKS_PER_EXTENSION,
  MAX_UI_PANEL_SLOTS,
  MIN_SCHEDULED_TASK_INTERVAL_MINUTES,
  MODULE_ACTION_NAME_PATTERN,
  MODULE_DATA_ROUTE_PATH_PATTERN,
  NAV_ITEM_HREF_PATTERN,
  NAV_ITEM_ID_PATTERN,
  NAV_ITEM_ICON_TOKENS,
  PANEL_DATA_PATH_PATTERN,
  REDIRECT_ORIGIN_PATTERN,
  SCHEDULED_TASK_HANDLER_NAME,
  SCHEDULED_TASK_NAME_PATTERN,
  UI_PANEL_SLOT_NAME_PATTERN,
  defineExtension,
} from './manifest.js'

export type { ExtensionRegistrationErrorReason } from './errors.js'
export { ExtensionRegistrationError } from './errors.js'

export type { ExtensionHooks } from './register-extension.js'
export { isExtensionApiVersionSupported, registerExtension } from './register-extension.js'
