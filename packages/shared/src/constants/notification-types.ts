export const NOTIFICATION_ALERT_TYPES = [
  'security.failed_auth_threshold',
  'credential.expiry',
  'service.down',
  'service.recovery',
  'rotation.stale',
  'backup.failure',
  'machine_key.expiry',
  'security.anomalous_access',
  'machine_cache.activated',
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
