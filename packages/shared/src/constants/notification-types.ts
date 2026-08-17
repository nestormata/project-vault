export const NOTIFICATION_ALERT_TYPES = [
  'security.failed_auth_threshold',
  'security.mfa_recovery_used',
  'security.mfa_recovery_codes_regenerated',
  'credential.expiry',
  'service.down',
  'service.recovery',
  'rotation.stale',
  'rotation.confirmation_failed',
  'rotation.max_retries_exceeded',
  'rotation.break_glass',
  'backup.failure',
  // Story 9.1 D7: 'backup.failure' was pre-reserved; 'backup.missed' is the one purely-additive
  // new entry this story needs (AC-12).
  'backup.missed',
  'machine_key.expiry',
  'security.anomalous_access',
  'machine_cache.activated',
  'machine_key.dormant',
  // Story 8.3 D5/D12/AC-16 — user dormancy alerts default to owner+admin union unless an org
  // configures an explicit override here (single role, honored exactly as any other alert type).
  'user.dormant',
  'payment.expiry',
  'certificate.expiry',
  'domain.expiry',
  // Story 9.2 AC-13: per-org usersPerOrg/secretsPerProject instance-limit threshold alerts
  // (advisory-only for maxUsersPerOrg, D3). 'resource.orgs_near_limit' (AC-14) deliberately has
  // NO entry here — it is instance-wide with no single org to route to (admin_alerts only, D7).
  'resource.users_near_limit',
  'resource.secrets_near_limit',
  // Story 9.2 AC-16: audit-log-storage-pressure tiered alerts — instance-wide but fans out to
  // every org (D7/D10), unlike resource.orgs_near_limit.
  'audit_storage.warning',
  'audit_storage.critical',
  // Story 22.1 AC-17/AC-18: per-org audit-storage-quota tiered alerts (scopeKey = orgId),
  // delivered to the org's OWN admins — never platform-wide, never naming other orgs.
  'audit_org_storage.warning',
  'audit_org_storage.critical',
  // Story 22.1 AC-7: usage reconciliation failed (statement_timeout or a hard error) — an
  // operator alert, not org-facing.
  'audit_usage_reconciliation.failing',
  // Story 22.1 AC-29: unauthenticated/pre-auth-attributable audit volume crossed the operator's
  // configured threshold — an operator alert (this volume never affects any tenant's quota).
  'audit_preauth_volume.high',
  // Story 9.2 AC-19/AC-20: master-key custody risk — delivered to every org owner (D7).
  'key_custody_risk',
  // Story 18.6: recipient-directed, informational notification. Unlike operational alerts,
  // this must be delivered at the default `info` threshold (see preferences.ts).
  'credential.share_created',
  // Story 17.2 AC-12: external recipients have no in-app account to notify, so admins are
  // notified instead — once at share creation, once at the recipient's first successful reveal
  // (never again for a single-use share).
  'credential.external_share_created',
  'credential.external_share_viewed',
] as const

export type NotificationAlertType = (typeof NOTIFICATION_ALERT_TYPES)[number]

export const NOTIFICATION_CHANNELS = ['email', 'slack', 'inbox'] as const
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number]

export const NOTIFICATION_FREQUENCIES = ['immediate', 'digest_daily'] as const
export type NotificationFrequency = (typeof NOTIFICATION_FREQUENCIES)[number]

export const NOTIFICATION_SEVERITIES = ['info', 'warning', 'critical'] as const
export type NotificationSeverity = (typeof NOTIFICATION_SEVERITIES)[number]

export const DEFAULT_NOTIFICATION_CHANNELS: NotificationChannel[] = ['email', 'inbox']
export const DEFAULT_NOTIFICATION_FREQUENCY: NotificationFrequency = 'immediate'
export const DEFAULT_NOTIFICATION_MIN_SEVERITY: NotificationSeverity = 'warning'

export const DEFAULT_ROUTING_ROLE = 'owner' as const
export type RoutingRole = 'owner' | 'admin' | 'member'
