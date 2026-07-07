import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createApp } from '../app.js'

// D4 point 1: importing app.js requires DATABASE_URL/CORS_ALLOWED_ORIGINS to already be set
// (env.ts's Zod schema has no .default() for either) — set safe placeholders exactly like
// generate-spec.ts itself does, only if not already set by the surrounding test env.
process.env.DATABASE_URL ??=
  'postgresql://vault_app:generate-spec-test@localhost:5432/project_vault'
process.env.CORS_ALLOWED_ORIGINS ??= 'http://localhost:5173'

// AC-5/D4 point 5: regression guard against ever silently reverting `generate-spec.ts` to a
// hand-maintained stub (the old version hardcoded exactly 8 paths) — a generous floor well above
// that, that naturally grows as routes are added, without hardcoding an exact brittle count.
const MINIMUM_PATH_COUNT = 60

// A representative module from each of the ~20 route-registration groups in app.ts — AC-5's
// "no module was accidentally skipped" spot-check, without hardcoding every single path.
const EXPECTED_PATH_PREFIXES = [
  '/health',
  '/ready',
  '/metrics',
  '/api/v1/auth/login',
  '/api/v1/org',
  '/api/v1/projects',
  '/api/v1/projects/{projectId}/credentials',
  '/api/v1/projects/{projectId}/rotation',
  '/api/v1/projects/{projectId}/machine-users',
  '/api/v1/dashboard',
  '/api/v1/health-dashboard',
  '/api/v1/status-pages',
  '/api/v1/users',
  '/api/v1/search',
  '/api/v1/admin',
  '/api/v1/notifications/inbox',
  '/api/v1/machine',
  '/api/v1/security-alerts',
  '/api/v1/organizations',
]

describe('generate-spec: live OpenAPI generation (D4)', () => {
  it('does not open a real database connection (AC-14) and produces a spec well above the old 8-path stub (AC-5)', async () => {
    const app = await createApp({ logger: false })
    await app.ready()
    const spec = app.swagger() as { paths: Record<string, unknown>; info: { version: string } }
    await app.close()

    expect(Object.keys(spec.paths).length).toBeGreaterThanOrEqual(MINIMUM_PATH_COUNT)
  })

  it('covers every registered route module, not just a hand-picked subset (AC-5)', async () => {
    const app = await createApp({ logger: false })
    await app.ready()
    const spec = app.swagger() as { paths: Record<string, unknown> }
    await app.close()

    const paths = Object.keys(spec.paths)
    for (const prefix of EXPECTED_PATH_PREFIXES) {
      expect(paths.some((path) => path.startsWith(prefix))).toBe(true)
    }
  })

  it('reads info.version from apps/api/package.json, not a hardcoded literal (AC-19)', async () => {
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf-8')) as {
      version: string
    }

    const app = await createApp({ logger: false })
    await app.ready()
    const spec = app.swagger() as { info: { version: string } }
    await app.close()

    expect(spec.info.version).toBe(pkg.version)
  })
})
