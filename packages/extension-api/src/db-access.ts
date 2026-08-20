/** Operations that may be granted to an extension role. Keep this union closed. */
export type ExtensionDbOperation = 'select' | 'insert' | 'update' | 'delete'

export type ExtensionDbScopeEntry = {
  table: string
  operations: ExtensionDbOperation[]
}

export type ExtensionDbUnavailableReason = 'not-configured' | 'no-approved-scope'

/** A deliberately small, untyped database surface, never a Drizzle client or PV schema type. */
export type ExtensionDbHandle = {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T[]>
  transaction<T>(callback: (tx: ExtensionDbHandle) => Promise<T>): Promise<T>
}

export type ExtensionRuntimeContext = {
  getDbHandle(): Promise<ExtensionDbHandle | { unavailable: ExtensionDbUnavailableReason }>
}
