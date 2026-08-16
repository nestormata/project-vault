import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import { checkNativeCredentialSurface } from './lib/check-native-credential-surface.js'
import type { SurfaceManifestEntry } from './lib/native-credential-surface-scan.js'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(SCRIPT_DIR, '..')
const MANIFEST_PATH = resolve(REPO_ROOT, 'apps/api/src/modules/auth/native-credential-surface.json')
const ROUTES_TS_PATH = 'apps/api/src/modules/auth/routes.ts'
const AC6_ROW_2 = 'AC-6 row 2'

describe('check-native-credential-surface (Story 23.2 AC-19)', () => {
  it('the checked-in manifest passes against the live tree', () => {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8')) as SurfaceManifestEntry[]
    const failures = checkNativeCredentialSurface(REPO_ROOT, manifest)
    expect(failures).toEqual([])
  })

  describe('synthetic tree fixtures', () => {
    let tmpRoot: string

    afterEach(() => {
      if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true })
    })

    function makeTree(files: Record<string, string>): string {
      const root = mkdtempSync(join(tmpdir(), 'ncs-test-'))
      for (const [relPath, content] of Object.entries(files)) {
        const full = join(root, relPath)
        mkdirSync(full.slice(0, full.lastIndexOf('/')), { recursive: true })
        // full is derived from a freshly created mkdtemp() directory plus a fixed relative path
        // supplied by this test file, not external input.
        // eslint-disable-next-line security/detect-non-literal-fs-filename
        writeFileSync(full, content)
      }
      return root
    }

    it('a synthetic unlisted P3 hit fails', () => {
      tmpRoot = makeTree({
        'apps/api/src/modules/auth/new-route.ts': `
          await tx.insert(accountRecoveryTokens).values({ userId, tokenHash })
        `,
      })
      const failures = checkNativeCredentialSurface(tmpRoot, [])
      expect(failures).toContainEqual(
        expect.objectContaining({
          kind: 'unlisted',
          hit: expect.objectContaining({ predicate: 'P3' }),
        })
      )
    })

    it('a dead manifest entry (code moved) fails', () => {
      tmpRoot = makeTree({
        [ROUTES_TS_PATH]: `const x = 1\n`,
      })
      const manifest: SurfaceManifestEntry[] = [
        {
          path: ROUTES_TS_PATH,
          line: 42,
          predicate: 'P1',
          symbol: 'verifyUserPassword',
          classification: 'gate',
          ac: AC6_ROW_2,
        },
      ]
      const failures = checkNativeCredentialSurface(tmpRoot, manifest)
      expect(failures).toContainEqual(expect.objectContaining({ kind: 'dead-entry' }))
    })

    it('a missing ac pointer fails', () => {
      tmpRoot = makeTree({
        [ROUTES_TS_PATH]: `await verifyUserPassword(a, b)\n`,
      })
      const manifest: SurfaceManifestEntry[] = [
        {
          path: ROUTES_TS_PATH,
          line: 1,
          predicate: 'P1',
          symbol: 'verifyUserPassword',
          classification: 'gate',
          ac: '',
        },
      ]
      const failures = checkNativeCredentialSurface(tmpRoot, manifest)
      expect(failures).toContainEqual(expect.objectContaining({ kind: 'missing-ac' }))
    })

    it('a gate-classified route that the gate helper does not wrap fails', () => {
      tmpRoot = makeTree({
        [ROUTES_TS_PATH]: `await verifyUserPassword(a, b)\n`,
      })
      const manifest: SurfaceManifestEntry[] = [
        {
          path: ROUTES_TS_PATH,
          line: 1,
          predicate: 'P1',
          symbol: 'verifyUserPassword',
          classification: 'gate',
          ac: AC6_ROW_2,
        },
      ]
      const failures = checkNativeCredentialSurface(tmpRoot, manifest)
      expect(failures).toContainEqual(expect.objectContaining({ kind: 'ungated-gate-entry' }))
    })

    it('a gate-classified route the gate helper DOES wrap passes', () => {
      tmpRoot = makeTree({
        [ROUTES_TS_PATH]: `
          if (!isNativeLoginEnabled()) return reply.status(403).send({})
          await verifyUserPassword(a, b)
        `,
      })
      const manifest: SurfaceManifestEntry[] = [
        {
          path: ROUTES_TS_PATH,
          line: 3,
          predicate: 'P1',
          symbol: 'verifyUserPassword',
          classification: 'gate',
          ac: AC6_ROW_2,
        },
      ]
      const failures = checkNativeCredentialSurface(tmpRoot, manifest)
      expect(failures).toEqual([])
    })

    it('an unknown classification fails', () => {
      tmpRoot = makeTree({
        [ROUTES_TS_PATH]: `await verifyUserPassword(a, b)\n`,
      })
      const manifest = [
        {
          path: ROUTES_TS_PATH,
          line: 1,
          predicate: 'P1',
          symbol: 'verifyUserPassword',
          classification: 'not-a-real-classification',
          ac: AC6_ROW_2,
        },
      ] as unknown as SurfaceManifestEntry[]
      const failures = checkNativeCredentialSurface(tmpRoot, manifest)
      expect(failures).toContainEqual(expect.objectContaining({ kind: 'unknown-classification' }))
    })
  })
})
