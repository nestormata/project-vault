import { describe, expect, it } from 'vitest'
import { allAssetsPresent, assetsPresentFromTables, extractTableNames } from './dump-inspect.js'

const PK_COLUMN_LINE = '  id uuid PRIMARY KEY'

describe('extractTableNames', () => {
  it('extracts every CREATE TABLE name from a plain-SQL pg_dump, lowercased', () => {
    const dump = [
      'CREATE TABLE public.credentials (',
      PK_COLUMN_LINE,
      ');',
      'CREATE TABLE IF NOT EXISTS "Users" (',
      PK_COLUMN_LINE,
      ');',
      'CREATE TABLE projects (',
      PK_COLUMN_LINE,
      ');',
    ].join('\n')

    const tables = extractTableNames(dump)

    expect(tables).toEqual(new Set(['credentials', 'users', 'projects']))
  })

  it('returns an empty set for a dump with no CREATE TABLE statements', () => {
    expect(extractTableNames('-- just comments\nSELECT 1;')).toEqual(new Set())
  })
})

describe('assetsPresentFromTables', () => {
  it('reports every compliance-relevant table as present when all are in the set', () => {
    const tables = new Set([
      'credentials',
      'projects',
      'users',
      'audit_log_entries',
      'data_erasure_requests',
    ])

    expect(assetsPresentFromTables(tables)).toEqual({
      credentials: true,
      projects: true,
      users: true,
      auditEvents: true,
      dataErasureRequests: true,
    })
  })

  it('reports each table independently as absent when missing from the set', () => {
    expect(assetsPresentFromTables(new Set())).toEqual({
      credentials: false,
      projects: false,
      users: false,
      auditEvents: false,
      dataErasureRequests: false,
    })
    expect(assetsPresentFromTables(new Set(['credentials']))).toMatchObject({
      credentials: true,
      projects: false,
    })
  })
})

describe('allAssetsPresent', () => {
  it('is true only when every asset flag is true', () => {
    expect(
      allAssetsPresent({
        credentials: true,
        projects: true,
        users: true,
        auditEvents: true,
        dataErasureRequests: true,
      })
    ).toBe(true)
  })

  it('is false when any single asset flag is false', () => {
    expect(
      allAssetsPresent({
        credentials: true,
        projects: true,
        users: true,
        auditEvents: true,
        dataErasureRequests: false,
      })
    ).toBe(false)
  })
})
