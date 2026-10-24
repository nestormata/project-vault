import { SvelteMap } from 'svelte/reactivity'
import { ApiClientError } from '$lib/api/client.js'
import {
  listBackups,
  restoreBackup,
  triggerBackup,
  validateBackup,
  type BackupListItem,
} from '$lib/api/platform.js'

export type BackupValidateResult = {
  valid: boolean
  assetsPresent: {
    credentials: boolean
    projects: boolean
    users: boolean
    auditEvents: boolean
    dataErasureRequests: boolean
  }
  checksum: 'match' | 'mismatch'
}

type ErrorBody = { code?: string; status?: string; message?: string } | null

const SEALED_MESSAGE = 'The vault was sealed while you were on this page — unseal it to continue.'

function isSealedBody(body: ErrorBody): boolean {
  return body !== null && 'status' in body && !('code' in body)
}

type ErrorRule = {
  when: (err: ApiClientError, body: ErrorBody) => boolean
  message: (err: ApiClientError, body: ErrorBody) => string
}

function messageFor(rules: readonly ErrorRule[], err: ApiClientError): string | null {
  const body = err.body as ErrorBody
  const rule = rules.find((r) => r.when(err, body))
  return rule === undefined ? null : rule.message(err, body)
}

const TRIGGER_RULES: readonly ErrorRule[] = [
  {
    when: (err) => err.status === 409 && err.code === 'backup_already_running',
    message: (err) => err.message ?? 'A backup is already in progress.',
  },
  {
    when: (err) => err.status === 429,
    message: () => 'Too many trigger attempts — wait a moment and try again.',
  },
  {
    when: (err, body) => err.status === 503 && isSealedBody(body),
    message: () => SEALED_MESSAGE,
  },
  {
    when: (err) => err.status === 503,
    message: (_err, body) => body?.message ?? 'Backup is not configured on this instance.',
  },
]

function triggerErrorMessage(err: unknown): string {
  const fallback = 'Failed to trigger backup.'
  if (!(err instanceof ApiClientError)) return fallback
  return messageFor(TRIGGER_RULES, err) ?? err.message ?? fallback
}

const RESTORE_RULES: readonly ErrorRule[] = [
  { when: (err, body) => err.status === 503 && isSealedBody(body), message: () => SEALED_MESSAGE },
  {
    when: (err, body) => err.status === 401 && body?.code === 'backup_decrypt_failed',
    message: () => 'Backup could not be decrypted with the current master key.',
  },
  {
    when: (err, body) => err.status === 422 && body?.code === 'backup_checksum_mismatch',
    message: () =>
      'Stored checksum does not match the backup file — refusing to restore a potentially corrupted or tampered backup.',
  },
  { when: (err) => err.status === 404, message: () => 'No backup found with that filename.' },
  {
    when: (err, body) => err.status === 409 && body?.code === 'restore_in_progress',
    message: () =>
      'Another restore is already in progress. Wait for it to complete before retrying.',
  },
  {
    when: (err, body) => err.status === 409 && body?.code === 'backup_in_progress',
    message: () => 'A backup is currently running. Wait for it to complete before restoring.',
  },
  { when: (err) => err.status === 409, message: (err) => err.message ?? 'Conflict.' },
  {
    when: (err, body) => err.status === 400 && body?.code === 'confirmation_required',
    message: () => 'Restore is destructive. confirmRestore: true and a reason are both required.',
  },
  {
    when: (err, body) => err.status === 400 && body?.code === 'invalid_filename',
    message: (_err, body) => body?.message ?? 'Not a well-formed backup filename.',
  },
  {
    when: (err) => err.status === 500,
    message: () => 'Restore failed unexpectedly. See server logs for details.',
  },
]

function restoreErrorMessage(err: unknown): string {
  const fallback = 'Restore failed.'
  if (!(err instanceof ApiClientError)) return fallback
  return messageFor(RESTORE_RULES, err) ?? err.message ?? fallback
}

/** The backups page's one owner of the list and of every trigger, validate and restore state. The
 * content component creates it and passes it to the sub-regions that read or drive it. */
export class BackupsController {
  // Story 68.1 AC-3: writable $derived, so a new load resets the list while refresh() can still
  // replace it locally.
  backups: BackupListItem[]
  triggerMessage = $state<string | null>(null)
  triggerError = $state<string | null>(null)
  readonly validateResults = new SvelteMap<string, unknown>()
  readonly validateErrors = new SvelteMap<string, string>()
  restoreExpandedFilename = $state<string | null>(null)
  restoreTypedMatches = $state(false)
  restoreReason = $state('')
  restoreError = $state<string | null>(null)
  restoreSuccess = $state<string | null>(null)
  restorePending = $state(false)
  restoreEnabled = $derived(
    this.restoreExpandedFilename !== null &&
      this.restoreTypedMatches &&
      this.restoreReason.trim().length > 0
  )
  constructor(loaded: () => BackupListItem[]) {
    this.backups = $derived(loaded())
  }

  validateResult(filename: string): BackupValidateResult | undefined {
    return this.validateResults.get(filename) as BackupValidateResult | undefined
  }

  async refresh(): Promise<void> {
    try {
      const result = await listBackups(fetch)
      this.backups = result.items
    } catch {
      // ignore refresh errors; user can reload manually
    }
  }

  async trigger(): Promise<void> {
    this.triggerMessage = null
    this.triggerError = null
    try {
      const result = await triggerBackup(fetch)
      this.triggerMessage = `Backup triggered (job ${result.jobId}). Refresh the list below to check progress.`
      await this.refresh()
    } catch (err) {
      this.triggerError = triggerErrorMessage(err)
    }
  }

  async validate(filename: string): Promise<void> {
    this.validateErrors.set(filename, '')
    try {
      const result = await validateBackup(fetch, filename)
      this.validateResults.set(filename, result)
      await this.refresh()
    } catch (err) {
      const msg =
        err instanceof ApiClientError ? (err.message ?? 'Validation failed') : 'Validation failed'
      this.validateErrors.set(filename, msg)
    }
  }

  openRestore(filename: string): void {
    this.restoreExpandedFilename = filename
    this.restoreTypedMatches = false
    this.restoreReason = ''
    this.restoreError = null
    this.restoreSuccess = null
  }

  closeRestore(): void {
    this.restoreExpandedFilename = null
    this.restoreTypedMatches = false
    this.restoreReason = ''
    this.restoreError = null
  }

  async restore(): Promise<void> {
    if (!this.restoreExpandedFilename) return
    this.restorePending = true
    this.restoreError = null
    this.restoreSuccess = null
    try {
      await restoreBackup(fetch, this.restoreExpandedFilename, {
        confirmRestore: true,
        reason: this.restoreReason,
      })
      this.restoreSuccess = this.restoreExpandedFilename
      this.restoreExpandedFilename = null
      await this.refresh()
    } catch (err) {
      this.restoreError = restoreErrorMessage(err)
      if (err instanceof ApiClientError && err.status === 404) await this.refresh()
    } finally {
      this.restorePending = false
    }
  }
}
