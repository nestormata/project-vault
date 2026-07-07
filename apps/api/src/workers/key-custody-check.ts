import { OperationalEvent } from '@project-vault/shared'
import type { FastifyBaseLogger } from 'fastify'
import { getDb } from '@project-vault/db'
import { vaultState } from '@project-vault/db/schema'
import { env } from '../config/env.js'
import { operationalLog } from '../lib/logger.js'
import type { BossService } from '../lib/boss.js'
import { isBackupEnabled } from '../modules/backup/config.js'
import {
  createAdminAlertIfNotActive,
  deliverAdminAlertAcrossOrgs,
} from '../modules/backup/alerts.js'

type WorkerLogger = Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>

const KEY_CUSTODY_RISK_ALERT_TYPE = 'key_custody_risk'
const MS_PER_DAY = 24 * 60 * 60 * 1000
const DOCS_URL = 'https://docs.project-vault.example/kms'

export type KeyCustodyTrigger = 'file_kms_with_backup' | 'key_age_exceeded'

/**
 * Story 9.2 FR109/AC-19/AC-20: evaluates both key-custody risk triggers against the current
 * `vault_state` row — (a) file-based KMS custody combined with backup being enabled (a single
 * compromised backup could expose the encryption key), and (b) `key_rotated_at` age exceeding
 * `KEY_ROTATION_MAX_AGE_DAYS` (D8: this column never advances past the migration's `initialized_at`
 * backfill until a future story ships rotation-execution — an accepted v1 limitation, not a bug in
 * this job).
 */
export async function evaluateKeyCustodyTriggers(): Promise<KeyCustodyTrigger[]> {
  const [state] = await getDb().select().from(vaultState).limit(1)
  if (!state) return []

  const triggers: KeyCustodyTrigger[] = []
  if (state.kmsType === 'file' && isBackupEnabled()) {
    triggers.push('file_kms_with_backup')
  }

  const rotatedAt = state.keyRotatedAt ?? state.initializedAt
  const daysSinceRotation = (Date.now() - rotatedAt.getTime()) / MS_PER_DAY
  if (daysSinceRotation > env.KEY_ROTATION_MAX_AGE_DAYS) {
    triggers.push('key_age_exceeded')
  }

  return triggers
}

/**
 * Story 9.2 AC-19/AC-20: weekly `key-custody/check` job (also runs at vault-unseal/startup, per
 * AC-19). Idempotent — one active `key_custody_risk` admin_alerts row per instance
 * (createAdminAlertIfNotActive), not one per check tick or per restart. Both triggers, if
 * simultaneously true, are merged into a single row's payload (`triggers: [...]`) rather than two
 * redundant alerts for "one conceptual custody-risk condition, two contributing reasons."
 * Delivered to every org owner on the instance (cross-org loop, D7) plus recorded platform-side.
 */
async function buildKeyCustodyPayload(
  triggers: KeyCustodyTrigger[]
): Promise<Record<string, unknown>> {
  const [state] = await getDb().select().from(vaultState).limit(1)
  const rotatedAt = state?.keyRotatedAt ?? state?.initializedAt ?? null
  const daysSinceRotation = rotatedAt
    ? Math.floor((Date.now() - rotatedAt.getTime()) / MS_PER_DAY)
    : null

  return {
    triggers,
    // Back-compat single-trigger field for the common (single-trigger) case (AC-19 example).
    trigger: triggers[0],
    message:
      'Master key custody risk detected — configure a KMS integration to mitigate. See docs for guidance.',
    docsUrl: DOCS_URL,
    ...(triggers.includes('key_age_exceeded')
      ? { daysSinceRotation, maxAgeDays: env.KEY_ROTATION_MAX_AGE_DAYS }
      : {}),
  }
}

export async function runKeyCustodyCheck(boss: BossService, logger?: WorkerLogger): Promise<void> {
  try {
    const triggers = await evaluateKeyCustodyTriggers()
    if (triggers.length === 0) return

    const payload = await buildKeyCustodyPayload(triggers)

    const alert = await createAdminAlertIfNotActive({
      alertType: KEY_CUSTODY_RISK_ALERT_TYPE,
      severity: 'warning',
      payload,
    })
    if (!alert) return // AC-19 idempotency: already an active row for this instance.

    if (logger) {
      operationalLog(
        logger,
        'warn',
        OperationalEvent.KEY_CUSTODY_RISK_DETECTED,
        'key custody risk detected',
        { triggers }
      )
    }
    await deliverAdminAlertAcrossOrgs(boss, KEY_CUSTODY_RISK_ALERT_TYPE, payload, 'warning')
  } catch (error) {
    if (logger) {
      operationalLog(
        logger,
        'error',
        OperationalEvent.KEY_CUSTODY_CHECK_FAILED,
        'key-custody/check job failed',
        { err: error instanceof Error ? { message: error.message, stack: error.stack } : error }
      )
    }
    throw error
  }
}
