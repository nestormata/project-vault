export const SYSTEM_TRACE_ID = 'system' as const

export const OperationalEvent = {
  // HTTP
  HTTP_REQUEST: 'http.request',

  // Lifecycle
  STARTUP_VAULT_STATUS: 'startup.vault_status',
  STARTUP_COMPLETE: 'startup.complete',
  STARTUP_FAILED: 'startup.failed',
  STARTUP_DB_CONNECTED: 'startup.db_connected',
  STARTUP_DB_FAILED: 'startup.db_failed',
  STARTUP_METRICS_EXPOSED: 'startup.metrics_exposed',
  SHUTDOWN_SIGNAL: 'shutdown.signal_received',
  SHUTDOWN_COMPLETE: 'shutdown.complete',
  SHUTDOWN_FAILED: 'shutdown.failed',
  HTTP_REQUEST_FAILED: 'http.request_failed',

  // Vault (migrated from `event: vault.*`)
  VAULT_INIT: 'vault.init',
  VAULT_INIT_FAILED: 'vault.init.failed',
  VAULT_UNSEAL: 'vault.unseal',
  VAULT_UNSEAL_FAILED: 'vault.unseal.failed',
  VAULT_SEAL: 'vault.seal',

  // Jobs (pg-boss)
  JOB_STARTED: 'job.started',
  JOB_COMPLETED: 'job.completed',
  JOB_FAILED: 'job.failed',

  // Auth (Stories 1.6-1.9 — register here, implement in those stories)
  AUTH_PASSWORD_HASH_CORRUPT: 'auth.password_hash_corrupt',
  SESSION_ACTIVITY_TOUCH_FAILED: 'session.activity_touch_failed',

  // Security / alerts (Epic 3 deferral marker)
  ALERT_PENDING_EPIC3: 'alert.pending_epic3',
  SECURITY_FAILED_AUTH_THRESHOLD_NO_ORG: 'security.failed_auth_threshold_no_org',
  SECURITY_MFA_ENROLLMENT_REQUIRED_DENIED: 'security.mfa_enrollment_required_denied',

  // DB
  DB_ERROR: 'db.error',

  // Credentials (Story 2.2)
  CREDENTIAL_REVEAL_ATTEMPT: 'credential.reveal.attempt',
  CREDENTIAL_REVEAL_SUCCESS: 'credential.reveal.success',
  CREDENTIAL_REVEAL_FAILURE: 'credential.reveal.failure',
  CREDENTIAL_AUDIT_WRITE_FAILED: 'credential.audit_write_failed',
  CREDENTIAL_RETENTION_SUMMARY: 'credential.retention.summary',
  CREDENTIAL_RETENTION_DRY_RUN: 'credential.retention.dry_run',
  CREDENTIAL_DEPENDENCY_ADDED: 'credential.dependency.added',
  CREDENTIAL_DEPENDENCY_ARCHIVED: 'credential.dependency.archived',
  CREDENTIAL_LIFECYCLE_UPDATED: 'credential.lifecycle.updated',
  CREDENTIAL_LIFECYCLE_INVALID_CRON: 'credential.lifecycle.invalid_cron',
  CREDENTIAL_IMPORT_PARSE_COMPLETED: 'credential.import.parse_completed',
  CREDENTIAL_IMPORT_ENCRYPTED: 'credential.import.encrypted',
  CREDENTIAL_IMPORT_CONFIRMED: 'credential.import.confirmed',
  CREDENTIAL_IMPORT_EXPIRED_ON_CONFIRM: 'credential.import.expired_on_confirm',
  CREDENTIAL_IMPORT_CLEANUP_RUN: 'credential.import.cleanup_run',
  CREDENTIAL_IMPORT_AUDIT_WRITE_FAILED: 'credential.import.audit_write_failed',
} as const

export type OperationalEventType = (typeof OperationalEvent)[keyof typeof OperationalEvent]
