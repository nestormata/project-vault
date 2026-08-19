import { describe, expect, it } from 'vitest'
import { findDestructiveStatements } from './migration-safety.js'

describe('privilege DDL migration safety (Story 23.5 AC-27)', () => {
  it('flags security-boundary privilege statements for explicit review', () => {
    const findings = findDestructiveStatements(
      'CREATE ROLE x; GRANT SELECT ON t TO x; REVOKE UPDATE ON t FROM x;'
    )
    expect(findings).toEqual(
      expect.arrayContaining([
        'CREATE ROLE (line 1)',
        'GRANT privilege (line 1)',
        'REVOKE privilege (line 1)',
      ])
    )
  })
})
