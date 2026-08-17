export const AuditEvent = {
  USER_REGISTERED: 'USER_REGISTERED',
  SESSION_CREATED: 'SESSION_CREATED',
  SESSION_REVOKED: 'SESSION_REVOKED',
  LOGIN_FAILED: 'LOGIN_FAILED',
  MFA_ENROLLMENT_STARTED: 'MFA_ENROLLMENT_STARTED',
  MFA_ENROLLED: 'MFA_ENROLLED',
  MFA_LOGIN_VERIFIED: 'MFA_LOGIN_VERIFIED',
  MFA_RECOVERY_USED: 'MFA_RECOVERY_USED',
  MFA_RECOVERY_CODES_REGENERATED: 'MFA_RECOVERY_CODES_REGENERATED',
  SECURITY_FAILED_AUTH_THRESHOLD: 'security.failed_auth_threshold',
  PROJECT_CREATED: 'project.created',
  PROJECT_UPDATED: 'project.updated',
  PROJECT_TAGS_UPDATED: 'project.tags_updated',
  CREDENTIAL_CREATED: 'credential.created',
  CREDENTIAL_VERSION_CREATED: 'credential.version_created',
  CREDENTIAL_VALUE_REVEALED: 'credential.value_revealed',
  CREDENTIAL_VERSION_PURGED: 'credential.version_purged',
  CREDENTIAL_TAGS_UPDATED: 'credential.tags_updated',
  CREDENTIAL_DEPENDENCY_ADDED: 'credential.dependency_added',
  CREDENTIAL_DEPENDENCY_ARCHIVED: 'credential.dependency_archived',
  CREDENTIAL_DEPENDENCY_UPDATED: 'credential.dependency_updated',
  CREDENTIAL_LIFECYCLE_UPDATED: 'credential.lifecycle_updated',
  CREDENTIAL_BULK_IMPORT_INITIATED: 'credential.bulk_import_initiated',
  CREDENTIAL_BULK_IMPORT_CONFIRMED: 'credential.bulk_import_confirmed',
  ONBOARDING_COMPLETED: 'onboarding.completed',
  CREDENTIAL_SEARCH: 'credential.search',
  PROJECT_INVITATION_CREATED: 'project.invitation_created',
  PROJECT_INVITATION_ACCEPTED: 'project.invitation_accepted',
  PROJECT_INVITATION_REVOKED: 'project.invitation_revoked',
  ORG_USER_REMOVED: 'org.user_removed',
  PROJECT_MEMBER_ROLE_CHANGED: 'project.member_role_changed',
  PROJECT_MEMBER_REMOVED: 'project.member_removed',
  PROJECT_OWNERSHIP_TRANSFERRED: 'project.ownership_transferred',
  PROJECT_ARCHIVED: 'project.archived',
  PROJECT_UNARCHIVED: 'project.unarchived',
  ORG_USER_DEACTIVATED: 'org.user_deactivated',
  ACCOUNT_RECOVERY_REQUESTED: 'auth.recovery_requested',
  ACCOUNT_RECOVERY_LINK_SENT: 'auth.recovery_link_sent',
  ACCOUNT_RECOVERY_COMPLETED: 'auth.recovery_completed',
  ACCOUNT_RECOVERY_BLOCKED: 'auth.recovery_blocked_no_admin',
  ROTATION_INITIATED: 'rotation.initiated',
  ROTATION_CHECKLIST_ITEM_CONFIRMED: 'rotation.checklist_item_confirmed',
  ROTATION_CHECKLIST_ITEM_FAILED: 'rotation.checklist_item_failed',
  ROTATION_CHECKLIST_ITEM_RETRIED: 'rotation.checklist_item_retried',
  ROTATION_CHECKLIST_ITEM_MAX_RETRIES_EXCEEDED: 'rotation.checklist_item_max_retries_exceeded',
  ROTATION_COMPLETED: 'rotation.completed',
  ROTATION_BREAK_GLASS_INITIATED: 'rotation.break_glass_initiated',
  ROTATION_SUPERSEDED_BY_BREAK_GLASS: 'rotation.superseded_by_break_glass',
  ROTATION_BREAK_GLASS_OVERLAP_EXPIRED: 'rotation.break_glass_overlap_expired',
  ROTATION_STALE_DETECTED: 'rotation.stale_detected',
  ROTATION_RESUMED: 'rotation.resumed',
  ROTATION_ABANDONED: 'rotation.abandoned',
  // Story 5.6
  ROTATION_PROMOTED: 'rotation.promoted',
  ROTATION_OLD_RETIRED: 'rotation.old_retired',
  ROTATION_STALE_STAGED_DETECTED: 'rotation.stale_staged_detected',
  STAGED_VALUE_REVEALED: 'rotation.staged_value_revealed',
  PAYMENT_RECORD_CREATED: 'payment_record.created',
  PAYMENT_RECORD_UPDATED: 'payment_record.updated',
  PAYMENT_RECORD_DELETED: 'payment_record.deleted',
  CERTIFICATE_CREATED: 'certificate.created',
  CERTIFICATE_UPDATED: 'certificate.updated',
  CERTIFICATE_DELETED: 'certificate.deleted',
  DOMAIN_RECORD_CREATED: 'domain_record.created',
  DOMAIN_RECORD_UPDATED: 'domain_record.updated',
  DOMAIN_RECORD_DELETED: 'domain_record.deleted',
  SERVICE_ENDPOINT_CREATED: 'service_endpoint.created',
  SERVICE_ENDPOINT_UPDATED: 'service_endpoint.updated',
  SERVICE_ENDPOINT_HEALTH_CHECK_PAUSED: 'service_endpoint.health_check_paused',
  SERVICE_ENDPOINT_HEALTH_CHECK_RESUMED: 'service_endpoint.health_check_resumed',
  SERVICE_ENDPOINT_DELETED: 'service_endpoint.deleted',
  MONITORING_ALERT_SNOOZED: 'monitoring_alert.snoozed',
  MONITORING_ALERT_DISMISSED: 'monitoring_alert.dismissed',
  SECURITY_ALERT_DISMISSED: 'security_alert.dismissed',
  MACHINE_USER_CREATED: 'machine_user.created',
  MACHINE_USER_API_KEY_ISSUED: 'machine_user.api_key_issued',
  MACHINE_USER_API_KEY_REVOKED: 'machine_user.api_key_revoked',
  MACHINE_USER_API_KEY_ROTATED: 'machine_user.api_key_rotated',
  MACHINE_USER_API_KEY_EMERGENCY_REVOKED: 'machine_user.api_key_emergency_revoked',
  MACHINE_USER_ROTATION_ANOMALY_DETECTED: 'machine_user.rotation_anomaly_detected',
  MACHINE_USER_DORMANCY_EXTENDED: 'machine_user.dormancy_extended',
  // Story 8-6 AC-5 — closes 7.1's forward-compatible-but-unused `deactivatedAt` column.
  MACHINE_USER_DEACTIVATED: 'machine_user.deactivated',
  MACHINE_CACHE_ACTIVATED: 'machine_cache.activated',
  STATUS_PAGE_ENABLED: 'status_page.enabled',
  STATUS_PAGE_TOKEN_REGENERATED: 'status_page.token_regenerated',
  STATUS_PAGE_UPDATED: 'status_page.updated',
  STATUS_PAGE_DISABLED: 'status_page.disabled',
  USER_ERASURE_REQUESTED: 'user.erasure_requested',
  USER_ERASURE_EXECUTED: 'user.erasure_executed',
  // Story 8.3 AC-7/AC-21
  ACCESS_REPORT_GENERATED: 'audit.access_report_generated',
  USER_PSEUDONYMIZED: 'user.pseudonymized',
  // Story 14.2: boot-time extension load lifecycle — written per-org (system-actor fanout, no
  // single natural org for a boot-time event) via apps/api/src/extensions/loader.ts.
  EXTENSION_LOADED: 'extension.loaded',
  EXTENSION_LOAD_FAILED: 'extension.load_failed',
  // Story 14.3 Task 8: SSO/external-identity linking audit events — SSO_LOGIN_REJECTED is written
  // on every AC-4/AC-7/AC-9 rejection path (mandatory, per Security Audit Personas elicitation),
  // never only on success.
  EXTERNAL_IDENTITY_LINKED: 'external_identity.linked',
  SSO_LOGIN_SUCCEEDED: 'sso_login.succeeded',
  SSO_LOGIN_REJECTED: 'sso_login.rejected',
  // Story 14.7 AC-3/AC-6: written on the new DELETE /api/v1/admin/external-identities/:id unlink
  // route, alongside the trio above.
  EXTERNAL_IDENTITY_UNLINKED: 'external_identity.unlinked',
  // Story 16.1 AC-7/AC-8: written on every successful reload of VAULT_THEMES_DIR (per-org
  // fanout at boot, single-org write on the authenticated POST /admin/themes/reload endpoint).
  THEME_RELOADED: 'theme.reloaded',
  // Story 16.2 AC-4: written on every successful PATCH /api/v1/themes/selection — a personal
  // preference change, but still a real, forensically-relevant action (was this user's own
  // account the one that made this change?). Same fail-closed convention as THEME_RELOADED
  // (writeHumanAuditEntryOrFailClosed inside the same transaction as the persisted selection).
  THEME_SELECTED: 'theme.selected',
  // Story 17.1 AC-9/FR124: written for every share creation, every successful reveal-step view
  // (not just the first), and every revocation — same fail-closed convention as the events above.
  CREDENTIAL_SHARE_CREATED: 'credential.share_created',
  CREDENTIAL_SHARE_VIEWED: 'credential.share_viewed',
  CREDENTIAL_SHARE_REVOKED: 'credential.share_revoked',
  // Story 17.3 AC-5/AC-13/AC-15: expiry (system-driven, no human actor — written via
  // writeSystemAuditEntryOrFailClosed by both the lazy-expiry check and the sweep worker),
  // supersession-on-promote (human-actor, one entry per superseded share), and nudge dismissal.
  CREDENTIAL_SHARE_EXPIRED: 'credential.share_expired',
  CREDENTIAL_SHARE_SUPERSEDED: 'credential.share_superseded',
  CREDENTIAL_SHARE_NUDGE_DISMISSED: 'credential.share_nudge_dismissed',
  // Story 23.2 AC-9: native-login-exclusion lifecycle. NATIVE_LOGIN_DISABLED is written once per
  // instance, per org, on the transition into the disabled policy (never on every boot, never on
  // a mid-process flip). NATIVE_LOGIN_BREAK_GLASS_ACTIVE fires once at boot when the break-glass
  // flag is set and the loaded extension declares replacement. NATIVE_LOGIN_BREAK_GLASS_RECOVERY_MINTED
  // is the value shared with the matching constant of the same name in
  // platform-audit-actions.ts's PlatformAuditAction registry — the AC-8a host-side CLI writes
  // into the whole-instance,
  // non-RLS platform_audit_events table (single fail-closed write) rather than this org-scoped,
  // per-org-fanout table, so this constant here is documentation/grep-ability only, not a value
  // ever inserted into audit_log_entries.
  // NATIVE_LOGIN_BOOTSTRAP_REGISTER_ALLOWED is written when AC-6a's carve-out lets a registration
  // through on an otherwise-gated instance. Deliberately NOT in this list: a rejected AC-6 request
  // (`native_login_disabled`) is an operational log line only, never an audit row (AC-9's H8
  // resolution) — an unauthenticated, org-less, high-volume rejection is not a per-tenant event.
  NATIVE_LOGIN_DISABLED: 'native_login.disabled',
  NATIVE_LOGIN_BREAK_GLASS_ACTIVE: 'native_login.break_glass_active',
  NATIVE_LOGIN_BREAK_GLASS_RECOVERY_MINTED: 'native_login.break_glass_recovery_minted',
  NATIVE_LOGIN_BOOTSTRAP_REGISTER_ALLOWED: 'native_login.bootstrap_register_allowed',
  // Story 23.3 AC-25: a capability-gate denial on an authenticated, org-scoped enforcement
  // (surface: 'org'). Payload is { capability, reasonCode } only — never the extension-controlled
  // `message` (free-form text does not belong in a tamper-evident audit trail).
  CAPABILITY_DENIED: 'capability.denied',
} as const

// Story 6.4 (P6-3, AC-J1/J2): this used to be hand-restated as a second literal union
// ('user.login' | 'user.logout' | ...), a fragile pattern that let entries silently drift out of
// sync (miss updating one side and you get a type-checking gap with no runtime symptom). It is
// now derived directly from the object above — the single place the set of valid audit-event
// strings is enumerated. This also drops 'user.login'/'user.logout', two literals that were never
// produced by AuditEvent and were never imported/type-checked against anywhere outside this file
// (packages/db's tests that reference these strings pass them as arbitrary literals against a
// plain `text` column, not against this registry — see audit-events.test.ts and
// packages/db/src/__tests__/*.test.ts).
export type AuthAuditEventType = (typeof AuditEvent)[keyof typeof AuditEvent]

export type AuditEvent = {
  type: AuthAuditEventType
  actorId: string
  orgId: string
  resourceId?: string
  metadata?: Record<string, unknown>
  timestamp: string
}
