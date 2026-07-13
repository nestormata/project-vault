import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const BACKUP_STORAGE_PATH_FIXTURE = '/var/backups'
const BACKUP_DATABASE_URL_FIXTURE = 'postgresql://backup:secret@localhost:5432/backup'

const mockEnv = vi.hoisted(() => ({
  env: {
    NODE_ENV: 'test',
    API_PORT: 3000,
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
    CORS_ALLOWED_ORIGINS: 'http://localhost:5173',
    METRICS_BIND_HOST: '127.0.0.1',
    LOG_LEVEL: 'silent',
    BACKUP_STORAGE_PATH: undefined as string | undefined,
    BACKUP_S3_BUCKET: undefined as string | undefined,
    BACKUP_S3_ENDPOINT: undefined as string | undefined,
    BACKUP_S3_REGION: undefined as string | undefined,
    BACKUP_DATABASE_URL: undefined as string | undefined,
  },
}))

vi.mock('../../config/env.js', () => mockEnv)

import { isBackupEnabled, resolveBackupDestination, requireBackupDatabaseUrl } from './config.js'

function resetBackupEnv(): void {
  mockEnv.env.BACKUP_STORAGE_PATH = undefined
  mockEnv.env.BACKUP_S3_BUCKET = undefined
  mockEnv.env.BACKUP_S3_ENDPOINT = undefined
  mockEnv.env.BACKUP_S3_REGION = undefined
  mockEnv.env.BACKUP_DATABASE_URL = undefined
}

beforeEach(() => {
  resetBackupEnv()
})

afterEach(() => {
  resetBackupEnv()
})

describe('isBackupEnabled', () => {
  it('returns true when BACKUP_STORAGE_PATH is set', () => {
    mockEnv.env.BACKUP_STORAGE_PATH = BACKUP_STORAGE_PATH_FIXTURE
    expect(isBackupEnabled()).toBe(true)
  })

  it('returns true when BACKUP_S3_BUCKET is set', () => {
    mockEnv.env.BACKUP_S3_BUCKET = 'my-bucket'
    expect(isBackupEnabled()).toBe(true)
  })

  it('returns true when BACKUP_DATABASE_URL is set', () => {
    mockEnv.env.BACKUP_DATABASE_URL = BACKUP_DATABASE_URL_FIXTURE
    expect(isBackupEnabled()).toBe(true)
  })

  it('returns false when none of the backup env vars are set', () => {
    expect(isBackupEnabled()).toBe(false)
  })
})

describe('resolveBackupDestination', () => {
  it('returns a filesystem destination when BACKUP_STORAGE_PATH is set', () => {
    mockEnv.env.BACKUP_STORAGE_PATH = BACKUP_STORAGE_PATH_FIXTURE
    expect(resolveBackupDestination()).toEqual({
      type: 'filesystem',
      path: BACKUP_STORAGE_PATH_FIXTURE,
    })
  })

  it('returns an s3 destination when BACKUP_S3_BUCKET is set and BACKUP_STORAGE_PATH is unset', () => {
    mockEnv.env.BACKUP_S3_BUCKET = 'my-bucket'
    mockEnv.env.BACKUP_S3_ENDPOINT = 'https://s3.example.com'
    mockEnv.env.BACKUP_S3_REGION = 'us-east-1'

    expect(resolveBackupDestination()).toEqual({
      type: 's3',
      bucket: 'my-bucket',
      endpoint: 'https://s3.example.com',
      region: 'us-east-1',
    })
  })

  it('returns null when neither BACKUP_STORAGE_PATH nor BACKUP_S3_BUCKET is set', () => {
    expect(resolveBackupDestination()).toBeNull()
  })

  it('prefers filesystem over s3 when both are set (BACKUP_STORAGE_PATH checked first)', () => {
    mockEnv.env.BACKUP_STORAGE_PATH = BACKUP_STORAGE_PATH_FIXTURE
    mockEnv.env.BACKUP_S3_BUCKET = 'my-bucket'

    expect(resolveBackupDestination()).toEqual({
      type: 'filesystem',
      path: BACKUP_STORAGE_PATH_FIXTURE,
    })
  })
})

describe('requireBackupDatabaseUrl', () => {
  it('returns the URL when BACKUP_DATABASE_URL is set', () => {
    mockEnv.env.BACKUP_DATABASE_URL = BACKUP_DATABASE_URL_FIXTURE
    expect(requireBackupDatabaseUrl()).toBe(BACKUP_DATABASE_URL_FIXTURE)
  })

  it('throws when BACKUP_DATABASE_URL is not configured', () => {
    expect(() => requireBackupDatabaseUrl()).toThrow('BACKUP_DATABASE_URL is not configured')
  })
})
