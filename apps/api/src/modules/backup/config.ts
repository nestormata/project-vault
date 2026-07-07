import { env } from '../../config/env.js'

export type BackupDestination =
  | { type: 'filesystem'; path: string }
  | { type: 's3'; bucket: string; endpoint?: string; region?: string }

/** Story 9.1 AC-15: backup is opt-in — disabled entirely when no destination/credential is
 * configured. `env.ts`'s own `validateBackupEnv` already enforces the fail-fast mutual-exclusivity
 * and "BACKUP_DATABASE_URL required when enabled" rules at startup, so by the time this function
 * is called at runtime, the configuration (if any) is already known-consistent. */
export function isBackupEnabled(): boolean {
  return Boolean(env.BACKUP_STORAGE_PATH || env.BACKUP_S3_BUCKET || env.BACKUP_DATABASE_URL)
}

export function resolveBackupDestination(): BackupDestination | null {
  if (env.BACKUP_STORAGE_PATH) return { type: 'filesystem', path: env.BACKUP_STORAGE_PATH }
  if (env.BACKUP_S3_BUCKET) {
    return {
      type: 's3',
      bucket: env.BACKUP_S3_BUCKET,
      endpoint: env.BACKUP_S3_ENDPOINT,
      region: env.BACKUP_S3_REGION,
    }
  }
  return null
}

/** D4: read live from the environment only at the moment pg_dump/pg_restore is spawned — never
 * held in a long-lived in-memory variable. */
export function requireBackupDatabaseUrl(): string {
  if (!env.BACKUP_DATABASE_URL) {
    throw new Error('requireBackupDatabaseUrl: BACKUP_DATABASE_URL is not configured')
  }
  return env.BACKUP_DATABASE_URL
}
