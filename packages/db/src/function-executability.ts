import { readFileSync } from 'node:fs'
import postgres from 'postgres'

/** The SQL file is the sole source of truth consumed by both TypeScript and psql. */
export const CANONICAL_FUNCTION_EXECUTABILITY_SQL = readFileSync(
  new URL('./sql/function-executability.sql', import.meta.url),
  'utf8'
)

const pinnedExtensionNames = [
  ...CANONICAL_FUNCTION_EXECUTABILITY_SQL.matchAll(/e\.extname\s+IN\s*\('([^']+)'\)/gi),
].map((match) => match[1])

export type ReviewedPublicExecutableAllowlistEntry = {
  identity: string
  reason: string
}

/**
 * Story 23.5's consumer contract. The SQL remains the sole source of truth; metadata is derived
 * from that query so a future pin or reviewed exception cannot silently diverge between callers.
 */
export const FUNCTION_EXECUTABILITY_CONTRACT = Object.freeze({
  sql: CANONICAL_FUNCTION_EXECUTABILITY_SQL,
  expectedMigrationFunctionOwnerRole: 'postgres' as const,
  pinnedExtensionNames: Object.freeze(pinnedExtensionNames),
  reviewedPublicExecutableAllowlist: Object.freeze(
    [] as readonly ReviewedPublicExecutableAllowlistEntry[]
  ),
})

export type FunctionExecutabilityViolation = {
  kind: 'function' | 'default_acl' | 'owner'
  signature: string | null
  detail: string
}

export type FunctionExecutabilityReport = {
  inScopeFunctionCount: number
  extensionFunctionCount: number
  inScopeFunctionSignatures: string[]
  extensionFunctionSignatures: string[]
  violations: FunctionExecutabilityViolation[]
}

export class FunctionExecutabilityViolationError extends Error {
  constructor(public readonly violations: FunctionExecutabilityViolation[]) {
    super(
      [
        'function executability invariant failed',
        ...violations.map((violation) => {
          const identity = violation.signature ?? 'default ACL'
          return `${identity}: ${violation.detail}`
        }),
      ].join('\n')
    )
    this.name = 'FunctionExecutabilityViolationError'
  }
}

export async function inspectFunctionExecutability(
  sql: postgres.Sql
): Promise<FunctionExecutabilityReport> {
  return sql.begin(async (transaction) => {
    await transaction.unsafe(CANONICAL_FUNCTION_EXECUTABILITY_SQL)

    const functions = await transaction<
      {
        signature: string
        is_pinned_extension_owned: boolean
      }[]
    >`
      SELECT signature, is_pinned_extension_owned
      FROM function_executability_functions
      ORDER BY signature
    `
    const violations = await transaction<FunctionExecutabilityViolation[]>`
      SELECT kind, signature, detail
      FROM function_executability_violations
      ORDER BY kind, signature NULLS LAST, detail
    `

    return {
      inScopeFunctionCount: functions.filter((row) => !row.is_pinned_extension_owned).length,
      extensionFunctionCount: functions.filter((row) => row.is_pinned_extension_owned).length,
      inScopeFunctionSignatures: functions
        .filter((row) => !row.is_pinned_extension_owned)
        .map((row) => row.signature),
      extensionFunctionSignatures: functions
        .filter((row) => row.is_pinned_extension_owned)
        .map((row) => row.signature),
      violations,
    }
  })
}

export async function assertFunctionExecutability(sql: postgres.Sql): Promise<void> {
  const report = await inspectFunctionExecutability(sql)
  if (report.violations.length > 0) {
    throw new FunctionExecutabilityViolationError(report.violations)
  }
}
