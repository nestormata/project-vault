import { describe, expect, it, vi } from 'vitest'

const { mockPostgres } = vi.hoisted(() => ({ mockPostgres: vi.fn() }))

vi.mock('postgres', () => ({ default: mockPostgres }))

import {
  EXTENSION_DB_DEFAULT_MAX,
  EXTENSION_DB_PLACEHOLDER_CREDENTIAL,
  createExtensionDbHandle,
  getExtensionDbHandle,
  getExtensionDbPoolMax,
  resetExtensionDbClientForTests,
  validateExtensionDatabaseUrl,
} from './extension-db.js'

const VALID_EXTENSION_URL = 'postgresql://vault_extension:password@db/project_vault'

describe('extension DB access contract (Story 23.5)', () => {
  it('uses a deliberately small explicit pool default and a shared placeholder constant', () => {
    expect(EXTENSION_DB_DEFAULT_MAX).toBe(3)
    expect(EXTENSION_DB_PLACEHOLDER_CREDENTIAL).toBe('dev-only-change-in-prod')
  })

  it.each([
    'postgresql://postgres:password@db.invalid:5432/project_vault',
    'postgresql://vault_app:password@db.invalid:5432/project_vault',
    'postgresql://vault_admin:password@db.invalid:5432/project_vault',
  ])('rejects a core or privileged role URL: %s', (url) => {
    expect(() => validateExtensionDatabaseUrl(url)).toThrow(/vault_extension|distinct|role/i)
  })

  it('exposes a tagged query and transaction surface without importing the core DB module', async () => {
    const calls: unknown[][] = []
    const sql = Object.assign(
      (...args: unknown[]) => {
        calls.push(args)
        return Promise.resolve([{ current_user: 'vault_extension' }])
      },
      { begin: async (fn: (tx: unknown) => Promise<unknown>) => fn(sql) }
    )
    const handle = createExtensionDbHandle(sql as never)
    expect(handle).toHaveProperty('query')
    expect(handle).toHaveProperty('transaction')
    expect(calls).toHaveLength(0)

    await handle.query`SELECT 1`
    await expect(handle.transaction(async (tx) => tx.query`SELECT 1`)).resolves.toEqual([
      { current_user: 'vault_extension' },
    ])
    expect(calls).toHaveLength(2)
  })

  it('validates pool sizing and lazily caches a client by URL and max size', async () => {
    expect(validateExtensionDatabaseUrl(VALID_EXTENSION_URL).protocol).toBe('postgresql:')
    expect(() => validateExtensionDatabaseUrl('not-a-url')).toThrow(/parseable/i)
    expect(() =>
      validateExtensionDatabaseUrl('mysql://vault_extension:password@db/project_vault')
    ).toThrow(/protocol/i)
    expect(() => getExtensionDbPoolMax('0')).toThrow(/positive integer/i)
    expect(() => getExtensionDbPoolMax('1.5')).toThrow(/positive integer/i)
    expect(getExtensionDbPoolMax('4')).toBe(4)
    expect(getExtensionDbHandle(undefined)).toBeUndefined()

    const client = Object.assign((...args: unknown[]) => Promise.resolve(args), {
      begin: async (work: (tx: unknown) => Promise<unknown>) => work(client),
      end: vi.fn().mockResolvedValue(undefined),
    })
    mockPostgres.mockReturnValue(client)

    const first = getExtensionDbHandle(VALID_EXTENSION_URL, 2)
    const second = getExtensionDbHandle(VALID_EXTENSION_URL, 2)
    expect(first).toBeDefined()
    expect(second).toBeDefined()
    expect(mockPostgres).toHaveBeenCalledTimes(1)
    getExtensionDbHandle(VALID_EXTENSION_URL, 3)
    expect(mockPostgres).toHaveBeenCalledTimes(2)
    resetExtensionDbClientForTests()
    expect(client.end).toHaveBeenCalled()
  })
})
