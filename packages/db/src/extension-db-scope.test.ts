import { describe, expect, it } from 'vitest'
import {
  EXTENSION_DB_SCOPE_DENYLIST,
  buildGrantStatements,
  canonicalizeDbScope,
  hashExtensionDbScope,
  quoteIdentifier,
  validateDbScopeTable,
} from './extension-db-scope.js'

describe('extension DB scope grant planning (Story 23.5)', () => {
  it('rejects injection-shaped identifiers before SQL is built', () => {
    for (const table of [
      'credentials; DROP TABLE users; --',
      '"credentials"',
      'public.credentials',
    ]) {
      expect(() => validateDbScopeTable(table)).toThrow(/identifier/i)
    }
  })

  it('keeps audit and pgboss objects on one shared deny-list', () => {
    expect(EXTENSION_DB_SCOPE_DENYLIST.has('audit_log_entries')).toBe(true)
    expect(EXTENSION_DB_SCOPE_DENYLIST.has('platform_audit_events')).toBe(true)
    expect(EXTENSION_DB_SCOPE_DENYLIST.has('platform_audit_pending_entries')).toBe(true)
  })

  it('quotes table identifiers and maps only closed operation verbs', () => {
    const statements = buildGrantStatements('vault_extension', [
      { table: 'credentials', operations: ['select', 'insert'] },
    ])
    expect(statements).toEqual([
      'GRANT INSERT ON TABLE "public"."credentials" TO "vault_extension"',
      'GRANT SELECT ON TABLE "public"."credentials" TO "vault_extension"',
    ])
    expect(() =>
      buildGrantStatements('vault_extension', [
        { table: 'credentials', operations: ['all' as never] },
      ])
    ).toThrow()
  })

  it('accepts valid identifiers and rejects invalid role identifiers before quoting', () => {
    expect(quoteIdentifier('public')).toBe('"public"')
    expect(quoteIdentifier('vault_extension')).toBe('"vault_extension"')
    expect(() => quoteIdentifier('public.credentials')).toThrow(/identifier/i)
    expect(() => buildGrantStatements('vault-extension', [])).toThrow(/identifier/i)
  })

  it('canonicalizes scope deterministically for approval hashing', () => {
    expect(
      canonicalizeDbScope([
        { table: 'service_endpoints', operations: ['select'] },
        { table: 'credentials', operations: ['insert', 'select'] },
      ])
    ).toEqual([
      { table: 'credentials', operations: ['insert', 'select'] },
      { table: 'service_endpoints', operations: ['select'] },
    ])
    expect(hashExtensionDbScope([{ table: 'credentials', operations: ['select'] }])).toBe(
      hashExtensionDbScope([{ table: 'credentials', operations: ['select', 'select'] }])
    )
  })
})
