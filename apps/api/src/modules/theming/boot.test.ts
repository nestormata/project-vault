import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createApp } from '../../app.js'
import { __resetThemeStateForTests, getThemesHealthField } from './service.js'

/**
 * Story 16.1 Task 5.3 — boot-sequence integration test mirroring
 * apps/api/src/extensions/boot.test.ts: exercises the REAL reloadThemesWithFanout() through the
 * actual createApp() call site, proving a fixture directory of valid/invalid theme files (or an
 * entirely unset VAULT_THEMES_DIR) can never crash/reject createApp() itself.
 */
const { mockThemesDir } = vi.hoisted(() => ({
  mockThemesDir: { value: undefined as string | undefined },
}))

vi.mock('../../config/env.js', () => ({
  env: {
    NODE_ENV: 'test',
    API_PORT: 3000,
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
    CORS_ALLOWED_ORIGINS: 'http://localhost:5173',
    METRICS_BIND_HOST: '127.0.0.1',
    LOG_LEVEL: 'silent',
    SERVICE_NAME: 'api',
    TRUST_PROXY: false,
    TRUST_PROXY_HOPS: 1,
    get VAULT_THEMES_DIR() {
      return mockThemesDir.value
    },
  },
}))

beforeEach(() => {
  __resetThemeStateForTests()
  mockThemesDir.value = undefined
})

describe('createApp() — Task 5 theming boot-sequence wiring', () => {
  it('boots successfully with VAULT_THEMES_DIR unset (AC-2)', async () => {
    const app = await createApp({ logger: false })
    expect(getThemesHealthField()).toEqual({ themesLoaded: 0, themesFailed: 0 })
    await app.close()
  })

  it('boots successfully when VAULT_THEMES_DIR points at a nonexistent directory (AC-2)', async () => {
    mockThemesDir.value = '/tmp/definitely-does-not-exist-theme-dir-16-1'
    await expect(createApp({ logger: false })).resolves.toBeDefined()
    expect(getThemesHealthField()).toEqual({ themesLoaded: 0, themesFailed: 0 })
  }, 15_000)

  it('boots successfully and picks up a mix of valid/invalid theme files from a real fixture directory (AC-1)', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')

    const dir = await mkdtemp(join(tmpdir(), 'theme-boot-fixture-'))
    try {
      await writeFile(
        join(dir, 'good.json'),
        JSON.stringify({ name: 'good-theme', tokens: { radiusMd: '4px' } })
      )
      await writeFile(join(dir, 'broken.json'), 'not valid json {{{')
      mockThemesDir.value = dir

      const app = await createApp({ logger: false })
      expect(getThemesHealthField()).toEqual({ themesLoaded: 1, themesFailed: 1 })
      await app.close()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 15_000)
})
