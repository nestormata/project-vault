import { describe, expect, it } from 'vitest'
import {
  EXTENSION_DB_DEFAULT_MAX,
  EXTENSION_DB_PLACEHOLDER_CREDENTIAL,
  createExtensionDbHandle,
  validateExtensionDatabaseUrl,
} from './extension-db.js'

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

  it('exposes a tagged query and transaction surface without importing the core DB module', () => {
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
  })
})
