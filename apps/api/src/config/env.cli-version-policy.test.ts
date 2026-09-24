import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'

/** Story 43.6 AC-7 — boot-time validation of the two CLI version-policy env vars. */

const BASE_ENV = {
  NODE_ENV: 'test',
  API_PORT: '3000',
  CORS_ALLOWED_ORIGINS: 'https://app.example.com',
  METRICS_BIND_HOST: '127.0.0.1',
  LOG_LEVEL: 'fatal',
  DATABASE_URL: 'postgresql://vault_app:secret@db.example.invalid:5432/project_vault',
  ADMIN_DATABASE_URL: 'postgresql://vault_admin:secret@db.example.invalid:5432/project_vault',
}

describe('env — CLI version policy (Story 43.6)', () => {
  let originalEnv: NodeJS.ProcessEnv
  let exitSpy: MockInstance<(...args: never[]) => unknown>
  let stderrSpy: MockInstance

  beforeEach(() => {
    originalEnv = process.env
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    vi.resetModules()
  })

  afterEach(() => {
    process.env = originalEnv
    vi.restoreAllMocks()
  })

  async function load(overrides: Record<string, string>) {
    process.env = { ...BASE_ENV, ...overrides }
    return (await import('./env.js')).env
  }

  async function expectBootFailure(overrides: Record<string, string>, mention: RegExp) {
    process.env = { ...BASE_ENV, ...overrides }
    await expect(import('./env.js')).rejects.toThrow(/Invalid environment/)
    expect(exitSpy).toHaveBeenCalledWith(1)
    expect(stderrSpy.mock.calls.join('\n')).toMatch(mention)
  }

  it('both are optional: unset → undefined minimum and no withdrawn versions', async () => {
    const env = await load({})
    expect(env.CLI_MINIMUM_SUPPORTED_VERSION).toBeUndefined()
    expect(env.CLI_WITHDRAWN_VERSIONS).toEqual([])
    expect(exitSpy).not.toHaveBeenCalled()
  })

  it('accepts a strict X.Y.Z minimum', async () => {
    const env = await load({ CLI_MINIMUM_SUPPORTED_VERSION: '1.1.0' })
    expect(env.CLI_MINIMUM_SUPPORTED_VERSION).toBe('1.1.0')
  })

  it('treats an empty minimum as unset', async () => {
    const env = await load({ CLI_MINIMUM_SUPPORTED_VERSION: '' })
    expect(env.CLI_MINIMUM_SUPPORTED_VERSION).toBeUndefined()
  })

  it.each(['v1.1.0', '1.1', '1.1.0-rc.1', '1.1.0+build', 'latest'])(
    'rejects minimum %j at boot',
    async (value) => {
      await expectBootFailure(
        { CLI_MINIMUM_SUPPORTED_VERSION: value },
        /CLI_MINIMUM_SUPPORTED_VERSION/
      )
    }
  )

  it.each<[string, string[]]>([
    ['1.2.1, 1.2.2', ['1.2.1', '1.2.2']],
    ['1.2.1,,', ['1.2.1']],
    [' 1.2.1 ,1.2.1, 1.3.0-rc.1', ['1.2.1', '1.3.0-rc.1']],
    ['', []],
  ])('parses withdrawn %j', async (value, expected) => {
    const env = await load({ CLI_WITHDRAWN_VERSIONS: value })
    expect(env.CLI_WITHDRAWN_VERSIONS).toEqual(expected)
  })

  it.each(['v1.2.1', '1.2', 'latest', '1.2.1+build'])(
    'rejects withdrawn entry %j at boot, naming it',
    async (value) => {
      const escaped = value.replace(/[.+]/g, '\\$&')
      await expectBootFailure({ CLI_WITHDRAWN_VERSIONS: `1.0.0,${value}` }, new RegExp(escaped))
    }
  )

  it('rejects more than 50 withdrawn entries', async () => {
    const list = Array.from({ length: 51 }, (_, i) => `1.0.${i}`).join(',')
    await expectBootFailure({ CLI_WITHDRAWN_VERSIONS: list }, /CLI_WITHDRAWN_VERSIONS/)
  })

  it('accepts exactly 50 withdrawn entries', async () => {
    const list = Array.from({ length: 50 }, (_, i) => `1.0.${i}`).join(',')
    expect((await load({ CLI_WITHDRAWN_VERSIONS: list })).CLI_WITHDRAWN_VERSIONS).toHaveLength(50)
  })
})
