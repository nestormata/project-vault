#!/usr/bin/env tsx
/**
 * Story 24.2 AC-6/AC-22: operator preflight for the configured admin pool.
 * Reads only the operator's process environment, never .env files, and never prints a DSN.
 */
import postgres from 'postgres'
import { inspectAdminPoolIdentity } from '../apps/api/src/lib/admin-pool-identity.js'

const adminUrl = process.env['ADMIN_DATABASE_URL']?.trim()
const databaseUrl = process.env['DATABASE_URL']?.trim()

if (!adminUrl) {
  process.stderr.write(
    'ADMIN_DATABASE_URL is required and must name the provisioned non-superuser role.\n'
  )
  process.exit(1)
}

function tuple(value: string): [string, string, string, string] | null {
  try {
    const url = new URL(value)
    return [url.username, url.hostname, url.port || '5432', url.pathname.replace(/^\//, '')]
  } catch {
    return null
  }
}

const adminTuple = tuple(adminUrl)
const databaseTuple = databaseUrl ? tuple(databaseUrl) : null
if (!adminTuple) {
  process.stderr.write('ADMIN_DATABASE_URL must be a parseable PostgreSQL URL.\n')
  process.exit(1)
}
if (adminTuple[0] === 'postgres') {
  process.stderr.write('ADMIN_DATABASE_URL must not use the postgres superuser.\n')
  process.exit(1)
}
if (databaseTuple && adminTuple.every((part, index) => part === databaseTuple[index])) {
  process.stderr.write('ADMIN_DATABASE_URL must use a distinct role from DATABASE_URL.\n')
  process.exit(1)
}

async function main(): Promise<void> {
  const client = postgres(adminUrl, { max: 1 })
  try {
    const result = await inspectAdminPoolIdentity(async () =>
      client.unsafe(
        'SELECT current_user, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user'
      )
    )
    if (result.status !== 'ok') {
      process.stderr.write(`Admin pool preflight failed: ${result.status}.\n`)
      process.exitCode = 1
    } else {
      process.stdout.write(
        `Admin pool preflight OK: role=${result.identity.current_user} rolsuper=${result.identity.rolsuper} rolbypassrls=${result.identity.rolbypassrls}\n`
      )
    }
  } finally {
    await client.end()
  }
}

void main()
