import { beforeEach, describe, it, expect, vi } from 'vitest'
import type { FastifyBaseLogger } from 'fastify'

const { mockEnv, BACKUP_PATH } = vi.hoisted(() => {
  const BACKUP_PATH = '/data/backups'
  return {
    BACKUP_PATH,
    mockEnv: {
      BACKUP_STORAGE_PATH: BACKUP_PATH as string | undefined,
      STATUS_DISK_MIN_FREE_PERCENT: 10,
    },
  }
})
vi.mock('../../config/env.js', () => ({ env: mockEnv }))

const { mockStatfs } = vi.hoisted(() => ({ mockStatfs: vi.fn() }))
vi.mock('node:fs/promises', () => ({ statfs: mockStatfs }))

const { checkDisk } = await import('./service.js')

function fakeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as FastifyBaseLogger
}

// bsize chosen so totalBytes/freeBytes land on round numbers for readable assertions
const BLOCK_SIZE = 1024

beforeEach(() => {
  mockEnv.BACKUP_STORAGE_PATH = BACKUP_PATH
  mockEnv.STATUS_DISK_MIN_FREE_PERCENT = 10
  mockStatfs.mockReset()
})

describe('checkDisk', () => {
  it('reports skipped when BACKUP_STORAGE_PATH is not configured', async () => {
    mockEnv.BACKUP_STORAGE_PATH = undefined
    const result = await checkDisk(fakeLogger())
    expect(result).toEqual({ status: 'skipped', reason: 'disk_not_configured' })
    expect(mockStatfs).not.toHaveBeenCalled()
  })

  it('reports ok when free space is above the configured threshold', async () => {
    mockStatfs.mockResolvedValue({ blocks: 1000, bavail: 500, bsize: BLOCK_SIZE }) // 50% free
    const result = await checkDisk(fakeLogger())
    expect(result).toEqual({ status: 'ok' })
  })

  it('reports disk_threshold_exceeded when free space is below the configured threshold', async () => {
    mockEnv.STATUS_DISK_MIN_FREE_PERCENT = 20
    mockStatfs.mockResolvedValue({ blocks: 1000, bavail: 100, bsize: BLOCK_SIZE }) // 10% free
    const result = await checkDisk(fakeLogger())
    expect(result).toEqual({ status: 'unavailable', reason: 'disk_threshold_exceeded' })
  })

  it('reports disk_check_failed without leaking the underlying error when statfs rejects', async () => {
    const logger = fakeLogger()
    mockStatfs.mockRejectedValue(
      new Error('ENOENT: no such file or directory, statfs /data/backups')
    )
    const result = await checkDisk(logger)
    expect(result).toEqual({ status: 'unavailable', reason: 'disk_check_failed' })
    expect(logger.error).toHaveBeenCalled()
    const loggedFields = JSON.stringify(vi.mocked(logger.error).mock.calls[0])
    expect(loggedFields).not.toContain(BACKUP_PATH)
    expect(loggedFields).not.toContain('ENOENT')
  })

  it('reports disk_check_failed when totalBytes is zero or negative (degenerate statfs result)', async () => {
    mockStatfs.mockResolvedValue({ blocks: 0, bavail: 0, bsize: BLOCK_SIZE })
    const result = await checkDisk(fakeLogger())
    expect(result).toEqual({ status: 'unavailable', reason: 'disk_check_failed' })
  })

  it('reports disk_check_failed and logs a warning when statfs never resolves within the timeout', async () => {
    const logger = fakeLogger()
    mockStatfs.mockReturnValue(new Promise(() => {})) // never settles
    const result = await checkDisk(logger)
    expect(result).toEqual({ status: 'unavailable', reason: 'disk_check_failed' })
    expect(logger.warn).toHaveBeenCalled()
  }, 3000)
})
