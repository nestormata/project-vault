import { describe, expect, it } from 'vitest'
import { parseSecrets } from './parse-secrets.js'

const PROJECT_A = 'a1c2d3e4-0000-0000-0000-000000000000'
const PROJECT_B = 'b5f6a7c8-0000-0000-0000-000000000000'

describe('parseSecrets', () => {
  describe('AC-2: single secret, happy path', () => {
    it('parses one PROJECT/NAME as ENV_VAR line', () => {
      const result = parseSecrets(`${PROJECT_A}/DATABASE_URL as DB_URL`)

      expect(result).toEqual({
        ok: true,
        projectId: PROJECT_A,
        entries: [{ projectId: PROJECT_A, credentialName: 'DATABASE_URL', envVarName: 'DB_URL' }],
      })
    })

    it('handles credential names containing extra slashes (splits PROJECT on first / only)', () => {
      const result = parseSecrets(`${PROJECT_A}/team/DATABASE_URL as DB_URL`)

      expect(result).toEqual({
        ok: true,
        projectId: PROJECT_A,
        entries: [
          { projectId: PROJECT_A, credentialName: 'team/DATABASE_URL', envVarName: 'DB_URL' },
        ],
      })
    })

    it('trims leading/trailing whitespace and normalizes internal whitespace around as', () => {
      const result = parseSecrets(`  ${PROJECT_A}/DATABASE_URL   as   DB_URL  `)

      expect(result).toEqual({
        ok: true,
        projectId: PROJECT_A,
        entries: [{ projectId: PROJECT_A, credentialName: 'DATABASE_URL', envVarName: 'DB_URL' }],
      })
    })

    it('skips blank lines between entries', () => {
      const result = parseSecrets(`\n${PROJECT_A}/DATABASE_URL as DB_URL\n\n`)

      expect(result).toEqual({
        ok: true,
        projectId: PROJECT_A,
        entries: [{ projectId: PROJECT_A, credentialName: 'DATABASE_URL', envVarName: 'DB_URL' }],
      })
    })
  })

  describe('AC-3: multiple secrets, one per line', () => {
    it('produces entries in input order', () => {
      const input = [
        `${PROJECT_A}/DATABASE_URL as DB_URL`,
        `${PROJECT_A}/STRIPE_SECRET_KEY as STRIPE_KEY`,
        `${PROJECT_A}/REDIS_URL as REDIS_URL`,
      ].join('\n')

      const result = parseSecrets(input)

      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error('expected success')
      expect(result.entries.map((e) => e.envVarName)).toEqual(['DB_URL', 'STRIPE_KEY', 'REDIS_URL'])
    })

    it('fails fast on duplicate ENV_VAR_NAME targets (case-insensitive)', () => {
      const input = [`${PROJECT_A}/DATABASE_URL as DB_URL`, `${PROJECT_A}/OTHER as db_url`].join(
        '\n'
      )

      const result = parseSecrets(input)

      expect(result).toEqual({ ok: false, error: 'Duplicate environment variable target: db_url' })
    })

    it('fails on empty secrets input', () => {
      const result = parseSecrets('   \n  \n')

      expect(result).toEqual({
        ok: false,
        error: "The 'secrets' input must contain at least one PROJECT/NAME as ENV_VAR mapping",
      })
    })

    it('rejects an envVarName that is not a safe identifier', () => {
      const result = parseSecrets(`${PROJECT_A}/DATABASE_URL as DB-URL`)

      expect(result).toEqual({
        ok: false,
        error: "Invalid environment variable target 'DB-URL': must match ^[A-Za-z_][A-Za-z0-9_]*$",
      })
    })

    it.each([
      'PATH',
      'LD_PRELOAD',
      'LD_LIBRARY_PATH',
      'DYLD_INSERT_LIBRARIES',
      'DYLD_LIBRARY_PATH',
      'NODE_OPTIONS',
      'HOME',
      'SHELL',
      'GITHUB_TOKEN',
      'GITHUB_WORKSPACE',
      'ACTIONS_RUNTIME_TOKEN',
    ])('rejects the reserved/dangerous env var target %s', (name) => {
      const result = parseSecrets(`${PROJECT_A}/DATABASE_URL as ${name}`)

      expect(result).toEqual({
        ok: false,
        error: `Refusing to export to reserved/dangerous environment variable '${name}' — this could hijack a later step's execution environment`,
      })
    })

    it('does not reject an ordinary identifier', () => {
      const result = parseSecrets(`${PROJECT_A}/DATABASE_URL as MY_APP_SECRET`)
      expect(result.ok).toBe(true)
    })

    it('rejects the denylist case-insensitively', () => {
      const result = parseSecrets(`${PROJECT_A}/DATABASE_URL as path`)

      expect(result).toEqual({
        ok: false,
        error:
          "Refusing to export to reserved/dangerous environment variable 'path' — this could hijack a later step's execution environment",
      })
    })
  })

  describe('AC-4: cross-project validation', () => {
    it('rejects mixed-project mappings before returning any entries', () => {
      const input = [
        `${PROJECT_A}/DATABASE_URL as DB_URL`,
        `${PROJECT_B}/API_TOKEN as API_TOKEN`,
      ].join('\n')

      const result = parseSecrets(input)

      expect(result).toEqual({
        ok: false,
        error: `All 'secrets' entries must reference the same project (found: ${PROJECT_A}, ${PROJECT_B}). One vault-action step retrieves secrets from exactly one project — split into multiple steps, each with that project's own api-key, to pull from multiple projects.`,
      })
    })

    it('treats project ids differing only in hex-digit casing as the same project', () => {
      const upper = PROJECT_A.toUpperCase()
      const input = [`${PROJECT_A}/DATABASE_URL as DB_URL`, `${upper}/API_TOKEN as API_TOKEN`].join(
        '\n'
      )

      const result = parseSecrets(input)

      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error('expected success')
      expect(result.projectId).toBe(PROJECT_A.toLowerCase())
    })

    it('passes through a non-UUID PROJECT segment as-is (no slug lookup)', () => {
      const result = parseSecrets('my-project/DATABASE_URL as DB_URL')

      expect(result).toEqual({
        ok: true,
        projectId: 'my-project',
        entries: [
          { projectId: 'my-project', credentialName: 'DATABASE_URL', envVarName: 'DB_URL' },
        ],
      })
    })

    it('trivially passes cross-project validation for a single line', () => {
      const result = parseSecrets(`${PROJECT_A}/DATABASE_URL as DB_URL`)
      expect(result.ok).toBe(true)
    })
  })

  describe('malformed lines', () => {
    it('fails with a parsing-specific message when " as " is missing', () => {
      const result = parseSecrets(`${PROJECT_A}/DATABASE_URL DB_URL`)

      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('expected failure')
      expect(result.error).toMatch(/Malformed 'secrets' line/)
      expect(result.error).not.toMatch(/retrieve/i)
    })

    it('fails with a parsing-specific message when PROJECT/NAME has no slash', () => {
      const result = parseSecrets('DATABASE_URL as DB_URL')

      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('expected failure')
      expect(result.error).toMatch(/Malformed 'secrets' line/)
    })
  })
})
