import { describe, expect, it } from 'vitest'
import { scanText } from './check-public-safety.js'

const LOCAL_ENDPOINT_RULE = 'local-endpoint'

describe('check-public-safety', () => {
  it('detects literal secret material', () => {
    const findings = scanText('docs/example.md', 'api_key = "super-secret-value"')
    expect(findings.some((finding) => finding.rule === 'secret-assignment')).toBe(true)
  })

  it('does not treat secret-related help markup as a secret assignment', () => {
    const findings = scanText(
      'apps/web/src/lib/components/auth/LoginForm.svelte',
      '<FormHelpText id="login-password-help" kind="secret" />'
    )

    expect(findings.some((finding) => finding.rule === 'secret-assignment')).toBe(false)
  })

  it('detects personal and machine-specific information', () => {
    const findings = scanText(
      'notes.md',
      'Contact nestor@example.com; local worktree: /home/nestor/project/.worktrees/story; http://localhost:5173'
    )
    expect(findings.map((finding) => finding.rule)).toEqual(
      expect.arrayContaining(['personal-email', 'local-path', LOCAL_ENDPOINT_RULE])
    )
  })

  it('does not flag ordinary implementation text', () => {
    expect(scanText('apps/web/src/lib/example.ts', 'export const answer = 42')).toEqual([])
  })

  it('does not treat the shared field-count domain constant as an environment variable', () => {
    expect(scanText('packages/shared/src/schemas/credentials.ts', 'MAX_FIELDS_PER_SECRET')).toEqual(
      []
    )
  })

  it('does not treat PostgreSQL connection-string userinfo as a personal email', () => {
    expect(
      scanText(
        'packages/db/src/test-db-urls.ts',
        'postgresql://vault_admin@admin-db.invalid:5432/project_vault'
      )
    ).not.toContainEqual(expect.objectContaining({ rule: 'personal-email' }))
  })

  it('allows reviewed public deployment names but still flags unknown secret-like names', () => {
    expect(
      scanText('docker-compose.yml', 'VAULT_ADMIN_PASSWORD: ${VAULT_ADMIN_PASSWORD:-password}')
    ).not.toContainEqual(expect.objectContaining({ rule: 'secret-environment-name' }))
    expect(scanText('docker-compose.yml', 'NEW_OPERATOR_PASSWORD: value')).toContainEqual(
      expect.objectContaining({ rule: 'secret-environment-name' })
    )
  })

  it('allows local endpoints only in reviewed local configuration files', () => {
    expect(
      scanText(
        '.env.example',
        'DATABASE_URL=postgresql://vault_app:password@localhost:5432/project_vault'
      )
    ).not.toContainEqual(expect.objectContaining({ rule: LOCAL_ENDPOINT_RULE }))
    expect(scanText('docs/example.md', 'http://localhost:5432')).toContainEqual(
      expect.objectContaining({ rule: LOCAL_ENDPOINT_RULE })
    )
  })
})
