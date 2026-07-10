// @vitest-environment node

import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildMigrationInvocation, generateE2EVaultPassphrase } from './e2e-setup-security.js'

describe('E2E global setup security', () => {
  it('generates a strong, unique vault passphrase for each E2E run', () => {
    const first = generateE2EVaultPassphrase()
    const second = generateE2EVaultPassphrase()

    expect(first.length).toBeGreaterThanOrEqual(32)
    expect(second.length).toBeGreaterThanOrEqual(32)
    expect(second).not.toBe(first)
  })

  it('invokes the migration through Node with absolute executable arguments', () => {
    const invocation = buildMigrationInvocation()
    const expectedMigrationScript = fileURLToPath(
      new URL('../../../../../packages/db/src/scripts/guarded-migrate.ts', import.meta.url)
    )

    expect(invocation.executable).toBe(process.execPath)
    expect(invocation.args).toHaveLength(2)
    expect(invocation.args.every((argument) => isAbsolute(argument))).toBe(true)
    expect(invocation.args[0]).toMatch(/[\\/]tsx[\\/]dist[\\/]cli\.mjs$/)
    expect(invocation.args[1]).toBe(expectedMigrationScript)
    expect(invocation.args.join(' ')).not.toMatch(/(?:^|\s)(?:pnpm|npx|tsx)(?:\s|$)|[;&|]/)
  })
})
