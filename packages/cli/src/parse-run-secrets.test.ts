import { describe, expect, it } from 'vitest'
import { parseRunSecrets } from './parse-run-secrets.js'

const DATABASE_URL = 'DATABASE_URL'
const FREE_FORM_NAME = 'my-db-password'

describe('parseRunSecrets', () => {
  it('parses a single bare NAME as both credential name and env var target', () => {
    const result = parseRunSecrets([DATABASE_URL])
    expect(result).toEqual({
      ok: true,
      entries: [{ credentialName: DATABASE_URL, envVarName: DATABASE_URL }],
    })
  })

  it('parses multiple --secret flags in order', () => {
    const result = parseRunSecrets([DATABASE_URL, 'API_TOKEN'])
    expect(result).toEqual({
      ok: true,
      entries: [
        { credentialName: DATABASE_URL, envVarName: DATABASE_URL },
        { credentialName: 'API_TOKEN', envVarName: 'API_TOKEN' },
      ],
    })
  })

  it('parses NAME=ENV_VAR renaming', () => {
    const result = parseRunSecrets([`${FREE_FORM_NAME}=MY_DB_PASSWORD`])
    expect(result).toEqual({
      ok: true,
      entries: [{ credentialName: FREE_FORM_NAME, envVarName: 'MY_DB_PASSWORD' }],
    })
  })

  it('rejects a bare credential name that is not a valid env var identifier and has no rename', () => {
    const result = parseRunSecrets([FREE_FORM_NAME])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain(FREE_FORM_NAME)
  })

  it('rejects an empty credential name (--secret =ENV_VAR)', () => {
    const result = parseRunSecrets(['=ENV_VAR'])
    expect(result.ok).toBe(false)
  })

  it('rejects an empty target env var (--secret NAME=)', () => {
    const result = parseRunSecrets(['NAME='])
    expect(result.ok).toBe(false)
  })

  it('rejects an invalid env var identifier on the rename side', () => {
    const result = parseRunSecrets(['NAME=not valid'])
    expect(result.ok).toBe(false)
  })

  it('returns zero entries for an empty list (caller decides whether that is a usage error)', () => {
    const result = parseRunSecrets([])
    expect(result).toEqual({ ok: true, entries: [] })
  })
})
