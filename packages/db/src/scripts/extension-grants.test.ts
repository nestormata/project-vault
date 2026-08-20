import { afterEach, describe, expect, it, vi } from 'vitest'
import { fileURLToPath } from 'node:url'
import type { ExtensionDbScopeEntry } from '../extension-db-scope.js'

const { mockPostgres } = vi.hoisted(() => ({ mockPostgres: vi.fn() }))

vi.mock('postgres', () => ({ default: mockPostgres }))

import { manifestScopeHash, main, reconcileExtensionGrants } from './extension-grants.js'

type CatalogRow = {
  exists: boolean
  rls_enabled: boolean
  org_policy: boolean
  owner_safe: boolean
}

type IdentityRow = { current_user: string; database_name: string; can_connect: boolean }
type CurrentGrantRow = { table_name: string; privilege_type: string }
type Approval = {
  extension_name: string
  manifest_scope_hash: string
  approved_scope: ExtensionDbScopeEntry[]
  tool_owned_grants: string[]
}

type MockSql = {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]>
  begin: (work: (tx: MockSql) => Promise<unknown>) => Promise<unknown>
  unsafe: (statement: string) => Promise<void>
  end: () => Promise<void>
}

function createMockSql(
  options: {
    identity?: IdentityRow
    catalog?: CatalogRow
    currentRows?: CurrentGrantRow[]
    approval?: Approval
    preflightError?: Error
  } = {}
): { sql: MockSql; unsafe: ReturnType<typeof vi.fn> } {
  const identity = options.identity ?? {
    current_user: 'postgres',
    database_name: 'project_vault',
    can_connect: true,
  }
  const catalog = options.catalog ?? {
    exists: true,
    rls_enabled: true,
    org_policy: true,
    owner_safe: true,
  }
  let beginCalls = 0
  const unsafe = vi.fn(async (_statement: string): Promise<void> => undefined)
  const sql = (async (strings: TemplateStringsArray): Promise<unknown[]> => {
    const query = strings.join(' ')
    if (query.includes('SELECT current_user')) return [identity]
    if (query.includes('SELECT EXISTS')) return [catalog]
    if (query.includes('information_schema.role_table_grants')) return options.currentRows ?? []
    if (query.includes('extension_db_scope_approvals')) {
      return options.approval ? [options.approval] : []
    }
    return []
  }) as MockSql
  sql.begin = async (work) => {
    beginCalls += 1
    if (beginCalls === 1 && options.preflightError) throw options.preflightError
    return work(sql)
  }
  sql.unsafe = unsafe
  sql.end = vi.fn(async (): Promise<void> => undefined)
  return { sql, unsafe }
}

const SCOPE: ExtensionDbScopeEntry[] = [{ table: 'credentials', operations: ['select'] }]
const EXTENSION_NAME = 'com.acme.sso-extension'
const GRANT_DATABASE_URL = 'postgresql://postgres:password@localhost/db'

function approved(scope: ExtensionDbScopeEntry[] = SCOPE): Approval {
  return {
    extension_name: EXTENSION_NAME,
    manifest_scope_hash: manifestScopeHash(scope),
    approved_scope: scope,
    tool_owned_grants: [],
  }
}

async function expectRejected(
  options: Parameters<typeof createMockSql>[0],
  message: RegExp,
  declaredScope: ExtensionDbScopeEntry[] = SCOPE
) {
  const { sql } = createMockSql(options)
  await expect(
    reconcileExtensionGrants({
      sql: sql as never,
      extensionName: EXTENSION_NAME,
      declaredScope,
    })
  ).rejects.toThrow(message)
}

afterEach(() => {
  mockPostgres.mockReset()
  delete process.env['EXTENSION_GRANT_DATABASE_URL']
  delete process.env['VAULT_EXTENSIONS_PACKAGE']
})

describe('reconcileExtensionGrants', () => {
  it('builds a least-privilege preview from an approved scope', async () => {
    const { sql, unsafe } = createMockSql({ approval: approved() })
    const plan = await reconcileExtensionGrants({
      sql: sql as never,
      extensionName: EXTENSION_NAME,
      declaredScope: SCOPE,
    })

    expect(plan.grants).toEqual([
      'GRANT SELECT ON TABLE "public"."credentials" TO "vault_extension"',
    ])
    expect(plan.revokes).toEqual([])
    expect(plan.foreign).toEqual([])
    expect(unsafe).toHaveBeenCalledTimes(3)
  })

  it('applies owned revokes and optionally revokes foreign grants', async () => {
    const staleGrant = 'GRANT UPDATE ON TABLE "public"."credentials" TO "vault_extension"'
    const foreignGrant = 'GRANT SELECT ON TABLE "public"."service_endpoints" TO "vault_extension"'
    const { sql, unsafe } = createMockSql({
      approval: { ...approved(), tool_owned_grants: [staleGrant] },
      currentRows: [
        { table_name: 'credentials', privilege_type: 'UPDATE' },
        { table_name: 'service_endpoints', privilege_type: 'SELECT' },
      ],
    })
    const plan = await reconcileExtensionGrants({
      sql: sql as never,
      extensionName: EXTENSION_NAME,
      declaredScope: SCOPE,
      apply: true,
      revokeForeign: true,
    })

    expect(plan.revokes).toEqual([staleGrant, foreignGrant])
    expect(unsafe).toHaveBeenCalledWith(
      'REVOKE UPDATE ON TABLE "public"."credentials" FROM "vault_extension"'
    )
    expect(unsafe).toHaveBeenCalledWith(
      'REVOKE SELECT ON TABLE "public"."service_endpoints" FROM "vault_extension"'
    )
  })

  it('fails closed for unsafe connections, missing approval, drift, denied scope, and bad catalog state', async () => {
    await expectRejected(
      {
        identity: { current_user: 'vault_app', database_name: 'project_vault', can_connect: true },
      },
      /grantee role/
    )
    await expectRejected({}, /No operator approval/)
    await expectRejected(
      { approval: { ...approved(), manifest_scope_hash: 'drifted' } },
      /scope drift/
    )
    await expectRejected({}, /denied audit/, [
      { table: 'audit_log_entries', operations: ['select'] },
    ])
    await expectRejected(
      { approval: approved(), catalog: { ...defaultCatalog(), exists: false } },
      /does not exist/
    )
    await expectRejected(
      { approval: approved(), catalog: { ...defaultCatalog(), rls_enabled: false } },
      /RLS\/org-policy/
    )
    await expectRejected(
      { approval: approved(), catalog: { ...defaultCatalog(), owner_safe: false } },
      /ownership invariant/
    )
  })

  it('fails closed when the grant connection cannot issue privilege DDL', async () => {
    await expectRejected(
      { approval: approved(), preflightError: new Error('denied') },
      /privilege DDL/
    )
  })
})

function defaultCatalog(): CatalogRow {
  return { exists: true, rls_enabled: true, org_policy: true, owner_safe: true }
}

describe('extension-grants CLI entrypoint', () => {
  it('does nothing when no extension is configured', async () => {
    process.env['EXTENSION_GRANT_DATABASE_URL'] = GRANT_DATABASE_URL
    await main()
    expect(mockPostgres).not.toHaveBeenCalled()
  })

  it('loads the configured extension, reconciles it, and closes the grant connection', async () => {
    const { sql } = createMockSql({
      approval: {
        extension_name: 'test.mock-capability-gate-extension',
        manifest_scope_hash: manifestScopeHash([]),
        approved_scope: [],
        tool_owned_grants: [],
      },
    })
    mockPostgres.mockReturnValue(sql)
    process.env['EXTENSION_GRANT_DATABASE_URL'] = GRANT_DATABASE_URL
    process.env['VAULT_EXTENSIONS_PACKAGE'] = fileURLToPath(
      new URL('../../../../fixtures/mock-capability-gate-extension/src/index.ts', import.meta.url)
    )

    await main()

    expect(mockPostgres).toHaveBeenCalledWith(GRANT_DATABASE_URL, { max: 1 })
    expect(sql.end).toHaveBeenCalledTimes(1)
  })
})
