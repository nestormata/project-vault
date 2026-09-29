import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createTestPki } from '@project-vault/shared/test-pki'

const CUSTOM_ADMIN_DATABASE_URL = 'postgresql://custom:custom@example.invalid:5432/custom_db'

const postgresMock = vi.fn((_url: string, _options?: unknown) => ({ __brand: 'postgres-client' }))
const drizzleMock = vi.fn((_client: unknown) => ({ __brand: 'drizzle-instance' }))

vi.mock('postgres', () => ({
  default: (...args: [string, unknown?]) => postgresMock(...args),
}))

vi.mock('drizzle-orm/postgres-js', () => ({
  drizzle: (...args: [unknown]) => drizzleMock(...args),
}))

vi.mock('../config/env.js', () => ({
  env: {
    get ADMIN_DATABASE_URL() {
      return process.env['ADMIN_DATABASE_URL']
    },
  },
}))

const ORIGINAL_ADMIN_DATABASE_URL = process.env['ADMIN_DATABASE_URL']

describe('getAdminDb', () => {
  beforeEach(() => {
    vi.resetModules()
    postgresMock.mockClear()
    drizzleMock.mockClear()
  })

  afterEach(() => {
    if (ORIGINAL_ADMIN_DATABASE_URL === undefined) {
      delete process.env['ADMIN_DATABASE_URL']
    } else {
      process.env['ADMIN_DATABASE_URL'] = ORIGINAL_ADMIN_DATABASE_URL
    }
  })

  it('uses ADMIN_DATABASE_URL when it is set', async () => {
    process.env['ADMIN_DATABASE_URL'] = CUSTOM_ADMIN_DATABASE_URL

    const { getAdminDb } = await import('./db.js')

    expect(() => getAdminDb()).not.toThrow()
    const result = getAdminDb()
    expect(result).toBeTruthy()
    // Story 43.16 AC-3: no DATABASE_TLS_* set, so the pinned-CA options are empty (plain, as before).
    expect(postgresMock).toHaveBeenCalledWith(CUSTOM_ADMIN_DATABASE_URL, {})
    expect(drizzleMock).toHaveBeenCalledTimes(1)
  })

  it('Story 43.16 AC-3: passes the pinned private CA when DATABASE_TLS_CA_B64 is set', async () => {
    process.env['ADMIN_DATABASE_URL'] = CUSTOM_ADMIN_DATABASE_URL
    const pki = await createTestPki()
    const originalCa = process.env['DATABASE_TLS_CA_B64']
    process.env['DATABASE_TLS_CA_B64'] = pki.ca.certB64
    try {
      const { getAdminDb } = await import('./db.js')
      getAdminDb()
      expect(postgresMock).toHaveBeenCalledWith(CUSTOM_ADMIN_DATABASE_URL, {
        ssl: { ca: pki.ca.certPem, minVersion: 'TLSv1.3', rejectUnauthorized: true },
      })
    } finally {
      if (originalCa === undefined) delete process.env['DATABASE_TLS_CA_B64']
      else process.env['DATABASE_TLS_CA_B64'] = originalCa
      await pki.cleanup()
    }
  })

  it('fails when the validated ADMIN_DATABASE_URL is unset', async () => {
    delete process.env['ADMIN_DATABASE_URL']

    const { getAdminDb } = await import('./db.js')

    expect(() => getAdminDb()).toThrow(/ADMIN_DATABASE_URL.*required/i)
    expect(postgresMock).not.toHaveBeenCalled()
    expect(drizzleMock).not.toHaveBeenCalled()
  })
})
