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
  ADMIN_POOL_IDENTITY_VERIFIED: 'admin_pool.identity_verified',
  ADMIN_POOL_IDENTITY_DRIFTED: 'admin_pool.identity_drifted',
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
  CREDENTIAL_DEPENDENCY_UPDATED: 'credential.dependency.updated',
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
  // Story 13.4 AC-3: rejected — targetFields named a key that doesn't exist on the credential's
  // current field_meta.
  ROTATION_INITIATE_UNKNOWN_FIELD_KEY: 'rotation.initiate.unknown_field_key',
  // Story 13.5 AC-1: rejected — same-value rotation without confirmSameValue: true.
  ROTATION_INITIATE_SAME_VALUE_CONFIRMATION_REQUIRED:
    'rotation.initiate.same_value_confirmation_required',
  // Story 13.5 AC-7: rejected — fieldValues' key set didn't exactly match targetFields'.
  ROTATION_INITIATE_FIELD_VALUES_TARGET_MISMATCH: 'rotation.initiate.field_values_target_mismatch',

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
  // Story 17.3 AC-7: the credential-share expiry-sweep worker's per-candidate/per-org failure
  // log, mirroring ROTATION_STALE_DETECTION_ROW_FAILED's "log and skip, never abort the rest of
  // the run" contract.
  CREDENTIAL_SHARE_EXPIRE_SWEEP_ROW_FAILED: 'credential_share.expire_sweep.row_failed',
  ROTATION_RESUME_SUCCESS: 'rotation.resume.success',
  ROTATION_RESUME_NOT_STALE: 'rotation.resume.not_stale',
  ROTATION_RESUME_CONCURRENT_MODIFICATION: 'rotation.resume.concurrent_modification',
  ROTATION_RESUME_AUDIT_FAILED: 'rotation.resume.audit_failed',
  ROTATION_ABANDON_SUCCESS: 'rotation.abandon.success',
  ROTATION_ABANDON_NOT_STALE: 'rotation.abandon.not_stale',
  ROTATION_ABANDON_CONCURRENT_MODIFICATION: 'rotation.abandon.concurrent_modification',
  ROTATION_ABANDON_AUDIT_FAILED: 'rotation.abandon.audit_failed',

  // Story 5.6
  ROTATION_PROMOTE_SUCCESS: 'rotation.promote.success',
  ROTATION_PROMOTE_NOT_PROMOTABLE: 'rotation.promote.not_promotable',
  ROTATION_PROMOTE_ACKNOWLEDGEMENT_REQUIRED: 'rotation.promote.acknowledgement_required',
  ROTATION_PROMOTE_CONCURRENT_MODIFICATION: 'rotation.promote.concurrent_modification',
  ROTATION_PROMOTE_AUDIT_FAILED: 'rotation.promote.audit_failed',
  ROTATION_RETIRE_SUCCESS: 'rotation.retire.success',
  ROTATION_RETIRE_NOT_RETIRABLE: 'rotation.retire.not_retirable',
  ROTATION_RETIRE_ACKNOWLEDGEMENT_REQUIRED: 'rotation.retire.acknowledgement_required',
  ROTATION_RETIRE_CONCURRENT_MODIFICATION: 'rotation.retire.concurrent_modification',
  ROTATION_RETIRE_AUDIT_FAILED: 'rotation.retire.audit_failed',
  ROTATION_LEGACY_COMPLETE_WRONG_STATE: 'rotation.legacy_complete.wrong_state',
  ROTATION_STAGED_VALUE_REVEAL_SUCCESS: 'rotation.staged_value_reveal.success',
  ROTATION_STAGED_VALUE_REVEAL_NOT_STAGED: 'rotation.staged_value_reveal.not_staged',
  ROTATION_STALE_STAGED_ALERTED: 'rotation.stale_staged.alerted',
  ROTATION_STALE_STAGED_ALERT_ROW_FAILED: 'rotation.stale_staged.alert_row_failed',

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

  // Story 14.2: extension loader (apps/api/src/extensions/loader.ts). Fatal-equivalent
  // failure-reason log — never carries the raw exception message/stack (fixed-enum reason
  // only, matching this codebase's secret-redaction-in-logs precedent).
  EXTENSION_LOAD_FAILED: 'extension.load_failed',
  // Story 24.3: an operator deliberately enabled the rollback escape for an above-host,
  // same-major extension version. This is a warning on every boot while the escape is active.
  EXTENSION_API_VERSION_ABOVE_HOST_ALLOWED: 'extension.api_version_above_host_allowed',
  // A single org's boot-time audit-fanout row failed to write — log-and-continue, distinct
  // from an actual extension load failure so the two are never conflated in monitoring.
  EXTENSION_AUDIT_FANOUT_ROW_FAILED: 'extension.audit_fanout_row_failed',
  // Dev Notes judgment call #5: a second loadExtension() invocation after state already
  // resolved (loaded or load_failed) is ignored rather than re-run — warn-logged so a
  // regression that double-invokes the loader is still visible in monitoring.
  EXTENSION_LOAD_DOUBLE_INVOCATION_IGNORED: 'extension.load_double_invocation_ignored',

  // Story 23.2: native-login-exclusion policy (apps/api/src/modules/auth/native-login-policy.ts).
  // AC-4a: fires on EVERY boot while the declared extension has never proven a successful
  // authentication — a permanently-broken integration must stay loud, not go silent after the
  // first warning.
  NATIVE_LOGIN_REPLACEMENT_PENDING: 'native_login.replacement_pending',
  // AC-8: fires on every boot while break-glass is set, regardless of whether an extension is
  // loaded (AC-16's "operational log always, audit fanout only when declared" split).
  NATIVE_LOGIN_BREAK_GLASS_ACTIVE_LOG: 'native_login.break_glass_active_log',
  // AC-4a: fires on every boot while the declaration-alone escape hatch is set.
  NATIVE_LOGIN_REPLACEMENT_CONFIRMED_OVERRIDE: 'native_login.replacement_confirmed_override',
  // AC-6: one line per AC-6-gated rejection — never an audit row (AC-9's H8 resolution).
  NATIVE_LOGIN_REJECTED: 'native_login.rejected',
  // AC-6a: fires whenever the bootstrap carve-out lets a registration through on an otherwise
  // gated instance.
  NATIVE_LOGIN_BOOTSTRAP_REGISTER_ALLOWED_LOG: 'native_login.bootstrap_register_allowed_log',
  // Mirrors EXTENSION_AUDIT_FANOUT_ROW_FAILED for this module's own per-org audit fanout.
  NATIVE_LOGIN_AUDIT_FANOUT_ROW_FAILED: 'native_login.audit_fanout_row_failed',
  // AC-8a: warn-severity operational log line written by the operator:recovery-link break-glass
  // CLI (apps/api/src/scripts/operator-recovery-link.ts) on EVERY invocation, minted or refused —
  // "a refused invocation is exactly the signal an operator wants."
  NATIVE_LOGIN_BREAK_GLASS_RECOVERY_MINTED_LOG: 'native_login.break_glass_recovery_minted_log',
  // AC-6e item 3: warn-severity boot log on every instance whose env.AUTH_DUMMY_PASSWORD_HASH
  // still equals the in-repo, publicly-known DEV_AUTH_DUMMY_PASSWORD_HASH constant — startup
  // additionally FAILS (this log line still fires first) when the resolved policy is anything
  // other than 'enabled', i.e. exactly the instances whose safety depends on the unusability
  // claim this AC is about.
  NATIVE_LOGIN_DUMMY_HASH_UNSAFE: 'native_login.dummy_hash_unsafe',
  // AC-6 pre-staging retroactive close: fires (warn) if the every-disabled-boot recovery-token
  // supersession sweep fails — must never crash boot or block the policy from resolving; a
  // failed sweep just leaves some pre-staged tokens live for another boot cycle.
  NATIVE_LOGIN_RECOVERY_TOKEN_SUPERSESSION_FAILED:
    'native_login.recovery_token_supersession_failed',
  // AC-7: resolveNativeLoginPolicy() itself must never be able to disable native login via a bug
  // in its own resolution logic — fatal-severity so a genuine bug here is impossible to miss,
  // mirroring loadExtension()'s "a bug in this story's own code cannot regress the still-starts
  // guarantee" design (app.ts).
  NATIVE_LOGIN_POLICY_RESOLUTION_FAILED: 'native_login.policy_resolution_failed',

  // Story 16.1: theming reload (apps/api/src/modules/theming/service.ts). AC-2's "directory
  // present but unreadable" operational-log distinction — never fired for the (silent, expected)
  // "directory absent" case.
  THEME_DIRECTORY_UNREADABLE: 'theme.directory_unreadable',
  // Dev Notes "Operational logging": info-level summary line on every reload (loaded/failed
  // counts + failed filenames), independent of the audit trail.
  THEME_RELOAD_SUMMARY: 'theme.reload_summary',
  // AC-7 edge case: mirrors EXTENSION_AUDIT_FANOUT_ROW_FAILED for the startup auto-reload pass's
  // per-org audit write failures (log-and-continue, never blocks boot).
  THEME_AUDIT_FANOUT_ROW_FAILED: 'theme.audit_fanout_row_failed',

  // Story 1.19: GET /status probe outcomes (AC-6 — probe traffic is counted, not audit-logged).
  STATUS_PROBE_SUCCESS: 'status.probe_success',
  STATUS_PROBE_DEGRADED: 'status.probe_degraded',
  STATUS_PROBE_UNAVAILABLE: 'status.probe_unavailable',
  STATUS_PROBE_UNAUTHORIZED: 'status.probe_unauthorized',
  STATUS_PROBE_RATE_LIMITED: 'status.probe_rate_limited',
  STATUS_CHECK_TIMEOUT: 'status.check_timeout',
  STATUS_CHECK_ERROR: 'status.check_error',
  // Story 1.19 adversarial review fix: the best-effort last-used timestamp write is still
  // best-effort (never blocks/fails the GET /status response) but its failure is no longer
  // silently discarded — this is the visibility signal.
  STATUS_TOKEN_TOUCH_FAILED: 'status.token_touch_failed',

  // Story 23.3: capability-entitlement gating extension hook (apps/api/src/lib/capability-gate.ts).
  // AC-7 edge case: a second wireExtensionCapabilityGate() call in the same process no-ops.
  CAPABILITY_GATE_DOUBLE_WIRE_IGNORED: 'capability_gate.double_wire_ignored',
  // AC-11: a registered gate threw, rejected, or timed out.
  CAPABILITY_GATE_FAILED: 'capability_gate.failed',
  CAPABILITY_GATE_TIMED_OUT: 'capability_gate.timed_out',
  // AC-12: a registered gate resolved something that fails the CapabilityDecision boundary schema.
  CAPABILITY_GATE_MALFORMED_DECISION: 'capability_gate.malformed_decision',
  // AC-12: a permitted:true decision carrying a reasonCode — most likely an inverted boolean bug,
  // the one malformed shape that grants access, so it is warn-logged even though it is honored.
  CAPABILITY_GATE_SUSPICIOUS_DECISION: 'capability_gate.suspicious_decision',
  // AC-10: the same capability id was checked twice within one request (a config error, never a
  // reason to memoize) — log-only backstop, does not throw in production.
  CAPABILITY_GATE_DOUBLE_CHECK: 'capability_gate.double_check',
  // AC-22: an id reaching assertCapability()/checkCapability() outside the closed CapabilityId set.
  CAPABILITY_GATE_UNKNOWN_ID: 'capability_gate.unknown_id',
  // AC-15: a check arrived over its accounting key's in-flight cap and was denied without
  // invoking the gate.
  CAPABILITY_GATE_SATURATED: 'capability_gate.saturated',
} as const

export type OperationalEventType = (typeof OperationalEvent)[keyof typeof OperationalEvent]
