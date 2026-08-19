import postgres from 'postgres'

export const EXTENSION_DB_DEFAULT_MAX = 3
export const EXTENSION_DB_PLACEHOLDER_CREDENTIAL = 'dev-only-change-in-prod'

export type ExtensionDbOperation = 'select' | 'insert' | 'update' | 'delete'
export type ExtensionDbUnavailableReason = 'not-configured' | 'no-approved-scope'

type ExtensionQuery = <Row extends Record<string, unknown> = Record<string, unknown>>(
  template: TemplateStringsArray,
  ...parameters: unknown[]
) => Promise<Row[]>
type ExtensionTransaction = <Result>(
  work: (scope: ExtensionDbHandle) => Promise<Result>
) => Promise<Result>

export type ExtensionDbHandle = {
  query: ExtensionQuery
  transaction: ExtensionTransaction
}

type SqlClient = ReturnType<typeof postgres>

export function createExtensionDbHandle(client: SqlClient): ExtensionDbHandle {
  return {
    query: ((template: TemplateStringsArray, ...parameters: unknown[]) =>
      client(template, ...(parameters as never[]))) as ExtensionQuery,
    transaction: async <Result>(work: (scope: ExtensionDbHandle) => Promise<Result>) =>
      client.begin(async (tx) =>
        work(createExtensionDbHandle(tx as unknown as SqlClient))
      ) as unknown as Promise<Result>,
  }
}

/** Validates only the role/protocol shape. Tuple collision checks belong to API env validation. */
export function validateExtensionDatabaseUrl(url: string): URL {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('EXTENSION_DATABASE_URL must be a parseable PostgreSQL URL')
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error('EXTENSION_DATABASE_URL must use the PostgreSQL protocol')
  }
  if (['postgres', 'vault_app', 'vault_admin'].includes(parsed.username)) {
    throw new Error('EXTENSION_DATABASE_URL must name a distinct least-privilege extension role')
  }
  return parsed
}

let extensionClient: SqlClient | null = null
let extensionClientKey: string | null = null

export function getExtensionDbPoolMax(value = process.env['EXTENSION_DATABASE_POOL_MAX']): number {
  const max = Number(value ?? EXTENSION_DB_DEFAULT_MAX)
  if (!Number.isInteger(max) || max < 1) {
    throw new Error('EXTENSION_DATABASE_POOL_MAX must be a positive integer')
  }
  return max
}

/** Creates a separate client only when the explicitly configured URL is requested. */
export function getExtensionDbHandle(
  url = process.env['EXTENSION_DATABASE_URL'],
  max = getExtensionDbPoolMax()
): ExtensionDbHandle | undefined {
  if (!url) return undefined
  validateExtensionDatabaseUrl(url)
  if (!Number.isInteger(max) || max < 1)
    throw new Error('EXTENSION_DATABASE_POOL_MAX must be a positive integer')
  const key = `${url}\u0000${max}`
  if (!extensionClient || extensionClientKey !== key) {
    extensionClient?.end({ timeout: 1 }).catch(() => undefined)
    extensionClient = postgres(url, { max })
    extensionClientKey = key
  }
  return createExtensionDbHandle(extensionClient)
}

export function resetExtensionDbClientForTests(): void {
  extensionClient?.end({ timeout: 1 }).catch(() => undefined)
  extensionClient = null
  extensionClientKey = null
}
