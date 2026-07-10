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
  // This names an operational log event describing a corrupt password hash, not a credential
  // value; there is no literal secret here. NOSONAR must sit on the flagged line itself.
  AUTH_PASSWORD_HASH_CORRUPT: 'auth.password_hash_corrupt', // NOSONAR(typescript:S2068)
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
  // Story 5.5 AC-3: revealCurrentValue() fell back past an abandoned version.
  CREDENTIAL_REVEAL_ABANDONED_VERSION_EXCLUDED: 'credential.reveal.abandoned_version_excluded',
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

  // Rotations (Story 5.1)
  ROTATION_INITIATE_SUCCESS: 'rotation.initiate.success',
  ROTATION_INITIATE_CONFLICT: 'rotation.initiate.conflict',
  ROTATION_INITIATE_AUDIT_FAILED: 'rotation.initiate.audit_failed',
  ROTATION_INITIATE_SAME_VALUE_WARNING: 'rotation.initiate.same_value_warning',
  // Story 5.5 AC-1: rejected — project archived concurrently with (or before) this initiation.
  ROTATION_INITIATE_PROJECT_ARCHIVED: 'rotation.initiate.project_archived',

  // Rotation checklist confirm/fail/retry/complete (Story 5.2)
  ROTATION_CHECKLIST_CONFIRM_SUCCESS: 'rotation.checklist.confirm.success',
  ROTATION_CHECKLIST_CONFIRM_ALREADY_CONFIRMED: 'rotation.checklist.confirm.already_confirmed',
  ROTATION_CHECKLIST_CONFIRM_INVALID_STATE: 'rotation.checklist.confirm.invalid_state',
  ROTATION_CHECKLIST_CONFIRM_CONCURRENT_MODIFICATION:
    'rotation.checklist.confirm.concurrent_modification',
  ROTATION_CHECKLIST_CONFIRM_AUDIT_FAILED: 'rotation.checklist.confirm.audit_failed',
  ROTATION_CHECKLIST_FAIL_SUCCESS: 'rotation.checklist.fail.success',
  ROTATION_CHECKLIST_FAIL_INVALID_STATE: 'rotation.checklist.fail.invalid_state',
  ROTATION_CHECKLIST_FAIL_CONCURRENT_MODIFICATION:
    'rotation.checklist.fail.concurrent_modification',
  ROTATION_CHECKLIST_FAIL_AUDIT_FAILED: 'rotation.checklist.fail.audit_failed',
  ROTATION_CHECKLIST_RETRY_SUCCESS: 'rotation.checklist.retry.success',
  ROTATION_CHECKLIST_RETRY_MAX_EXCEEDED: 'rotation.checklist.retry.max_exceeded',
  ROTATION_CHECKLIST_RETRY_INVALID_STATE: 'rotation.checklist.retry.invalid_state',
  ROTATION_CHECKLIST_RETRY_CONCURRENT_MODIFICATION:
    'rotation.checklist.retry.concurrent_modification',
  ROTATION_CHECKLIST_RETRY_AUDIT_FAILED: 'rotation.checklist.retry.audit_failed',
  ROTATION_COMPLETE_SUCCESS: 'rotation.complete.success',
  ROTATION_COMPLETE_CHECKLIST_INCOMPLETE: 'rotation.complete.checklist_incomplete',
  ROTATION_COMPLETE_ACKNOWLEDGEMENT_REQUIRED: 'rotation.complete.acknowledgement_required',
  ROTATION_COMPLETE_CONCURRENT_MODIFICATION: 'rotation.complete.concurrent_modification',
  ROTATION_COMPLETE_AUDIT_FAILED: 'rotation.complete.audit_failed',

  // Break-glass / stale-recovery (Story 5.3)
  ROTATION_BREAK_GLASS_SUCCESS: 'rotation.break_glass.success',
  ROTATION_BREAK_GLASS_LOCK_CONTENTION: 'rotation.break_glass.lock_contention',
  ROTATION_BREAK_GLASS_AUDIT_FAILED: 'rotation.break_glass.audit_failed',
  ROTATION_BREAK_GLASS_SUPERSEDED: 'rotation.break_glass.superseded',
  ROTATION_BREAK_GLASS_OVERLAP_EXPIRED: 'rotation.break_glass.overlap_expired',
  ROTATION_STALE_DETECTED: 'rotation.stale.detected',
  // Story 5.5 AC-9: one candidate row's transaction failed (e.g. an audit-write throw) — logged
  // and skipped so the rest of the same job run (other orgs/rotations) still gets processed.
  ROTATION_STALE_DETECTION_ROW_FAILED: 'rotation.stale.detection_row_failed',
  ROTATION_BREAK_GLASS_EXPIRE_ROW_FAILED: 'rotation.break_glass.expire_row_failed',
  ROTATION_RESUME_SUCCESS: 'rotation.resume.success',
  ROTATION_RESUME_NOT_STALE: 'rotation.resume.not_stale',
  ROTATION_RESUME_CONCURRENT_MODIFICATION: 'rotation.resume.concurrent_modification',
  ROTATION_RESUME_AUDIT_FAILED: 'rotation.resume.audit_failed',
  ROTATION_ABANDON_SUCCESS: 'rotation.abandon.success',
  ROTATION_ABANDON_NOT_STALE: 'rotation.abandon.not_stale',
  ROTATION_ABANDON_CONCURRENT_MODIFICATION: 'rotation.abandon.concurrent_modification',
  ROTATION_ABANDON_AUDIT_FAILED: 'rotation.abandon.audit_failed',

  // Operational monitoring expiry alerts (Story 6.1)
  MONITORING_EXPIRY_ALERT_ROW_FAILED: 'monitoring.expiry_alert_row_failed',

  // Notification queue DLQ cleanup (Story 3.5)
  NOTIFICATION_DLQ_CLEANUP_SUMMARY: 'notification.dlq_cleanup.summary',

  // HTTP endpoint monitoring health-check scheduler (Story 6.2, ADR-6.2-09)
  MONITORING_HEALTH_CHECK_TICK_SKIPPED_OVERLAP: 'monitoring.health_check_tick_skipped_overlap',
  MONITORING_HEALTH_CHECK_ROW_FAILED: 'monitoring.health_check_row_failed',

  // Audit log search/export/forwarding/retention (Story 8.2)
  AUDIT_WEBHOOK_FORWARD_ROW_FAILED: 'audit.webhook_forward.row_failed',
  AUDIT_WEBHOOK_FORWARD_DISABLED: 'audit.webhook_forward.disabled',
  AUDIT_S3_FORWARD_UPLOAD_FAILED: 'audit.s3_forward.upload_failed',
  AUDIT_S3_FORWARD_DAY_SKIPPED_EMPTY: 'audit.s3_forward.day_skipped_empty',
  AUDIT_S3_FORWARD_DISABLED: 'audit.s3_forward.disabled',
  AUDIT_RETENTION_PRUNE_SUMMARY: 'audit.retention_prune.summary',
  AUDIT_RETENTION_PRUNE_ROW_FAILED: 'audit.retention_prune.row_failed',

  // Encrypted Backup & Restore (Story 9.1 D6) — interim operational-logging audit trail for
  // backup/restore/validate actions, pending Story 9.4's platform_audit_events retrofit.
  BACKUP_TRIGGERED: 'backup.triggered',
  BACKUP_COMPLETED: 'backup.completed',
  BACKUP_FAILED: 'backup.failed',
  BACKUP_MISSED: 'backup.missed',
  BACKUP_RESTORE_INITIATED: 'backup.restore.initiated',
  BACKUP_RESTORE_COMPLETED: 'backup.restore.completed',
  BACKUP_RESTORE_FAILED: 'backup.restore.failed',
  BACKUP_VALIDATE_INITIATED: 'backup.validate.initiated',
  BACKUP_VALIDATE_COMPLETED: 'backup.validate.completed',
  BACKUP_RETENTION_PRUNED: 'backup.retention_pruned',
  // Story 9.6 D2/AC-11: emitted when the hourly health-check job auto-resolves a `backup.missed`
  // admin_alerts row (no notification is delivered for this — only the original "missed" alert is
  // notification-worthy).
  BACKUP_MISSED_RESOLVED: 'backup.missed_resolved',
  // Story 9.6 D2 failure isolation (adversarial review, high): the alert-resolve step is wrapped
  // in its own try/catch, independent of the orphan-cleanup/disk-pressure scan — this event fires
  // when the resolve step itself throws, so a filesystem error in the unrelated cleanup scan can
  // never mask this job's most important reliability signal (and vice versa).
  BACKUP_MISSED_RESOLVE_FAILED: 'backup.missed_resolve_failed',
  // Story 9.6 AC-20: audit-relevant log covering every restore attempt outcome (accepted or
  // rejected at the lock or at filename validation) — closes the gap where a blocked restore
  // attempt against a secrets-vault's full-database-restore path left no trace of who attempted it.
  BACKUP_RESTORE_ATTEMPTED: 'backup.restore_attempted',

  // System Settings, Multi-Org & Resource Monitoring (Story 9.2 D6/AC-25) — interim
  // operational-logging audit trail for platform-operator actions, pending Story 9.4's
  // platform_audit_events retrofit (same D6 pattern Story 9.1 established for backup/restore).
  PLATFORM_SETTINGS_UPDATED: 'platform_admin.settings_updated',
  PLATFORM_ORG_CREATED: 'platform_admin.org_created',
  // AC-17/D10: the audit-storage maintenance-mode circuit breaker.
  AUDIT_WRITE_SUSPENDED: 'audit.write_suspended',
  AUDIT_STORAGE_MAINTENANCE_MODE_ENTERED: 'audit_storage.maintenance_mode_entered',
  AUDIT_STORAGE_MAINTENANCE_MODE_EXITED: 'audit_storage.maintenance_mode_exited',
  AUDIT_STORAGE_CHECK_FAILED: 'audit_storage.check_failed',
  // AC-19/AC-20: master-key custody risk alerting.
  KEY_CUSTODY_RISK_DETECTED: 'key_custody.risk_detected',
  KEY_CUSTODY_CHECK_FAILED: 'key_custody.check_failed',

  // Story 9.3 D2/AC-17: guarded-migrate.ts's destructive-migration refusal/allow/apply events.
  // Emitted as pre-vault-unseal operational logs (no org/audit context available — this is a
  // one-shot infra container, not an authenticated request), never as audit_log_entries rows.
  MIGRATION_DESTRUCTIVE_REFUSED: 'migration.destructive_refused',
  MIGRATION_DESTRUCTIVE_ALLOWED: 'migration.destructive_allowed',
  MIGRATION_APPLIED: 'migration.applied',

  // Story 9.4 AC-17/AC-18: platform operator audit log retention pruning and storage monitoring.
  PLATFORM_AUDIT_RETENTION_PRUNE_SUMMARY: 'platform_audit.retention_prune.summary',
  PLATFORM_AUDIT_STORAGE_CHECK_FAILED: 'platform_audit_storage.check_failed',
} as const

export type OperationalEventType = (typeof OperationalEvent)[keyof typeof OperationalEvent]
