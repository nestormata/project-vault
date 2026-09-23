import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  chmodSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  deleteSession,
  readSession,
  sessionDir,
  sessionFilePath,
  writeSession,
  type SessionData,
} from './session-store.js'

let xdgHome: string

function envFor(): Record<string, string | undefined> {
  return { XDG_CONFIG_HOME: xdgHome }
}

const SAMPLE: SessionData = {
  accessToken: 'access-token-value',
  refreshToken: 'refresh-token-value',
  accessExpiresAt: new Date(Date.now() + 300_000).toISOString(),
  userId: 'a1c2d3e4-0000-0000-0000-000000000000',
  orgId: 'b1c2d3e4-0000-0000-0000-000000000000',
  baseUrl: 'https://vault.example.com',
}

beforeEach(() => {
  xdgHome = mkdtempSync(join(tmpdir(), 'pvault-session-test-'))
})

afterEach(() => {
  rmSync(xdgHome, { recursive: true, force: true })
})

describe('session-store — AC-1 write permissions', () => {
  it('creates the parent directory with mode 0700', () => {
    writeSession(SAMPLE, envFor())
    const dirStat = statSync(sessionDir(envFor()))
    expect(dirStat.mode & 0o777).toBe(0o700)
  })

  it('writes the session file with mode 0600, verified via fs.statSync', () => {
    writeSession(SAMPLE, envFor())
    const fileStat = statSync(sessionFilePath(envFor()))
    expect(fileStat.mode & 0o777).toBe(0o600)
  })

  it('writes valid JSON that round-trips through readSession', () => {
    writeSession(SAMPLE, envFor())
    const result = readSession(envFor())
    expect(result).toEqual({ status: 'ok', session: SAMPLE })
  })

  it('leaves no temp file behind after a successful write (atomic rename)', () => {
    writeSession(SAMPLE, envFor())
    const entries = readdirSync(sessionDir(envFor()))
    expect(entries).toEqual(['session.json'])
  })
})

describe('session-store — AC-5 permission check before every read', () => {
  it('refuses a group/world-readable session file distinctly from "not found"', () => {
    writeSession(SAMPLE, envFor())
    chmodSync(sessionFilePath(envFor()), 0o644)

    const result = readSession(envFor())

    expect(result.status).toBe('insecure_permissions')
    if (result.status === 'insecure_permissions') {
      expect(result.path).toBe(sessionFilePath(envFor()))
    }
  })

  it('returns not_found when no session file exists at all', () => {
    const result = readSession(envFor())
    expect(result).toEqual({ status: 'not_found' })
  })

  it('re-checks permissions on every call, not just at write time', () => {
    writeSession(SAMPLE, envFor())
    expect(readSession(envFor()).status).toBe('ok')
    chmodSync(sessionFilePath(envFor()), 0o640)
    expect(readSession(envFor()).status).toBe('insecure_permissions')
  })
})

describe('session-store — AC-4 concurrency: malformed JSON never throws', () => {
  it('treats unparseable file contents as not_found rather than throwing', () => {
    writeSession(SAMPLE, envFor())
    writeFileSync(sessionFilePath(envFor()), '{not valid json', { mode: 0o600 })
    chmodSync(sessionFilePath(envFor()), 0o600)

    expect(() => readSession(envFor())).not.toThrow()
    expect(readSession(envFor())).toEqual({ status: 'not_found' })
  })

  it('treats a well-permissioned but structurally-wrong JSON file as not_found', () => {
    const dir = sessionDir(envFor())
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(sessionFilePath(envFor()), JSON.stringify({ foo: 'bar' }), { mode: 0o600 })

    expect(readSession(envFor())).toEqual({ status: 'not_found' })
  })
})

describe('session-store — AC-6 logout deletion is idempotent', () => {
  it('deletes an existing session file', () => {
    writeSession(SAMPLE, envFor())
    const result = deleteSession(envFor())
    expect(result).toEqual({ deleted: true })
    expect(readSession(envFor())).toEqual({ status: 'not_found' })
  })

  it('is a no-op success when no session file exists', () => {
    const result = deleteSession(envFor())
    expect(result).toEqual({ deleted: false })
  })

  it('a second logout after the first is still success, not an error', () => {
    writeSession(SAMPLE, envFor())
    expect(deleteSession(envFor())).toEqual({ deleted: true })
    expect(deleteSession(envFor())).toEqual({ deleted: false })
  })
})
