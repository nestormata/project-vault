import { describe, expect, it } from 'vitest'
import { CliUsageError } from './exit-codes.js'
import { resolveConfig, warnIfInsecureBaseUrl } from './config.js'

const PROJECT_ID = 'a1c2d3e4-0000-0000-0000-000000000000'
const VAULT_URL = 'https://vault.example.com'

describe('resolveConfig', () => {
  it('resolves apiKey/baseUrl/projectId from VAULT_* env vars (Dev Notes decision #2)', () => {
    const env = {
      VAULT_API_KEY: 'pk_abc123',
      VAULT_URL,
      VAULT_PROJECT_ID: PROJECT_ID,
    }
    expect(resolveConfig({}, env)).toEqual({
      apiKey: 'pk_abc123',
      baseUrl: VAULT_URL,
      projectId: PROJECT_ID,
    })
  })

  it('an explicit CLI flag overrides the same env var', () => {
    const env = {
      VAULT_API_KEY: 'pk_env',
      VAULT_URL: 'https://env.example.com',
      VAULT_PROJECT_ID: PROJECT_ID,
    }
    const result = resolveConfig({ apiKey: 'pk_flag', url: 'https://flag.example.com' }, env)
    expect(result.apiKey).toBe('pk_flag')
    expect(result.baseUrl).toBe('https://flag.example.com')
  })

  it('throws CliUsageError naming every missing required value, before any network call', () => {
    expect(() => resolveConfig({}, {})).toThrow(CliUsageError)
    try {
      resolveConfig({}, {})
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(CliUsageError)
      const message = (error as Error).message
      expect(message).toContain('VAULT_API_KEY')
      expect(message).toContain('VAULT_URL')
      expect(message).toContain('VAULT_PROJECT_ID')
    }
  })

  it('throws CliUsageError naming only the specific missing value', () => {
    const env = { VAULT_API_KEY: 'pk_abc', VAULT_URL }
    expect(() => resolveConfig({}, env)).toThrow(/VAULT_PROJECT_ID/)
  })
})

describe('warnIfInsecureBaseUrl', () => {
  it('does not warn for an https URL', () => {
    const writes: string[] = []
    warnIfInsecureBaseUrl(VAULT_URL, (chunk) => writes.push(chunk))
    expect(writes).toHaveLength(0)
  })

  it('does not warn for http://localhost', () => {
    const writes: string[] = []
    warnIfInsecureBaseUrl('http://localhost:3000', (chunk) => writes.push(chunk))
    expect(writes).toHaveLength(0)
  })

  it('does not warn for http://127.0.0.1', () => {
    const writes: string[] = []
    warnIfInsecureBaseUrl('http://127.0.0.1:3000', (chunk) => writes.push(chunk))
    expect(writes).toHaveLength(0)
  })

  it('warns on stderr for a non-loopback http:// URL', () => {
    const writes: string[] = []
    warnIfInsecureBaseUrl('http://vault.example.com', (chunk) => writes.push(chunk))
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatch(/plaintext|insecure|http/i)
  })
})
