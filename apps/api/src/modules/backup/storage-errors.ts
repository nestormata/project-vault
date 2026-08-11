/**
 * Story 9.9: classifies a filesystem-destination error thrown by `atomic-write.ts`/`storage.ts`'s
 * `filesystemStorage()` into a stable, sanitized, operator-actionable category message — instead
 * of the raw `error.message` previously stored verbatim into `backup_runs.errorMessage` (AC-4).
 *
 * Scope: filesystem destination ONLY. `service.ts`'s `executeBackupSnapshot` must never route an
 * S3-destination error through this classifier — S3 errors keep their existing (unclassified)
 * `error.message` handling, unchanged by this story.
 *
 * Secrets discipline (AC-4 edge case / intent-contract "Never" clause): the returned message is
 * built entirely from a fixed category string, the operator-configured `BACKUP_STORAGE_PATH`, and
 * fixed remediation text — it NEVER interpolates `error.message` (which, for a raw Node fs error,
 * is generally safe but not worth the risk) or any other request/environment value that could
 * carry a DB URL, encryption key, dump content, or bearer token.
 */

const REQUIRED_UID = 1000
const REQUIRED_GID = 1000
const RUNBOOK_REFERENCE = 'docs/runbook.md § Backup & Recovery → Backup permission remediation'

export type StorageErrorCategory = 'permission' | 'full' | 'unavailable' | 'generic'

const CODE_TO_CATEGORY: Record<string, StorageErrorCategory> = {
  EACCES: 'permission',
  EPERM: 'permission',
  ENOSPC: 'full',
  EDQUOT: 'full',
  ENOENT: 'unavailable',
  ENOTDIR: 'unavailable',
  EROFS: 'unavailable',
}

function categoryFor(code: string | undefined): StorageErrorCategory {
  if (!code) return 'generic'
  // `code` is a Node.js errno string (e.g. 'EACCES') from `NodeJS.ErrnoException.code`, not
  // user/request input; the lookup result is always narrowed by the `?? 'generic'` fallback
  // regardless of what key is probed.
  return CODE_TO_CATEGORY[code] ?? 'generic' // eslint-disable-line security/detect-object-injection
}

const CATEGORY_MESSAGES: Record<StorageErrorCategory, string> = {
  permission:
    'Backup storage permission error: the API process could not write to BACKUP_STORAGE_PATH ' +
    `(configured path shown below). The runtime container expects this directory to be owned by ` +
    `uid:gid ${REQUIRED_UID}:${REQUIRED_GID}. See ${RUNBOOK_REFERENCE} to verify/repair ownership ` +
    'for a named volume or bind mount.',
  full:
    'Backup storage is full: BACKUP_STORAGE_PATH ran out of disk space or inodes while writing ' +
    `the backup. Free space on the volume/mount, then retry. See ${RUNBOOK_REFERENCE}.`,
  unavailable:
    'Backup storage is unavailable: BACKUP_STORAGE_PATH does not exist, is not a directory, or ' +
    `its filesystem is read-only. Confirm the volume/mount is attached and writable (uid:gid ` +
    `${REQUIRED_UID}:${REQUIRED_GID}). See ${RUNBOOK_REFERENCE}.`,
  generic:
    'Backup storage write failed: an unclassified filesystem error occurred while writing to ' +
    `BACKUP_STORAGE_PATH. See ${RUNBOOK_REFERENCE} and the structured server logs (correlated by ` +
    'run ID) for the underlying error code.',
}

/**
 * Maps a thrown filesystem-destination error to a stable category and a sanitized,
 * operator-actionable message referencing `BACKUP_STORAGE_PATH`, the required 1000:1000
 * uid/gid, and the runbook remediation section. `configuredPath` is the operator-configured
 * `BACKUP_STORAGE_PATH` value (never user input) and is safe to include verbatim.
 */
export function classifyStorageError(
  error: unknown,
  configuredPath: string
): { category: StorageErrorCategory; message: string } {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  const category = categoryFor(code)
  return {
    category,
    // `category` is always one of the four literal StorageErrorCategory values returned by
    // `categoryFor` above — never user/request input.
    message: `${CATEGORY_MESSAGES[category]} (BACKUP_STORAGE_PATH=${configuredPath})`, // eslint-disable-line security/detect-object-injection
  }
}
