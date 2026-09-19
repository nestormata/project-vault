import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import { checkNativeCredentialSurface } from './lib/check-native-credential-surface.js'
import type { SurfaceManifestEntry } from './lib/native-credential-surface-scan.js'
import { runCheckOnly, runWrite } from './check-native-credential-surface.js'

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

const WRITE_TEST_P1 = 'P1'
const WRITE_TEST_SYMBOL = 'verifyUserPassword(a, b)'
const WRITE_TEST_CLASSIFICATION = 'non-runtime'

function makeWriteTestEntry(overrides: Partial<SurfaceManifestEntry> = {}): SurfaceManifestEntry {
  return {
    path: ROUTES_TS_PATH,
    line: 1,
    predicate: WRITE_TEST_P1,
    symbol: WRITE_TEST_SYMBOL,
    classification: WRITE_TEST_CLASSIFICATION,
    ac: AC6_ROW_2,
    ...overrides,
  }
}

describe('--write CLI mode (Story 40.2)', () => {
  let tmpRoot: string
  let manifestPath: string

  afterEach(() => {
    if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true })
  })

  function makeFixture(files: Record<string, string>, manifest: SurfaceManifestEntry[]): void {
    tmpRoot = mkdtempSync(join(tmpdir(), 'ncs-write-test-'))
    for (const [relPath, content] of Object.entries(files)) {
      const full = join(tmpRoot, relPath)
      mkdirSync(full.slice(0, full.lastIndexOf('/')), { recursive: true })
      // full is derived from a freshly created mkdtemp() directory plus a fixed relative path
      // supplied by this test file, not external input.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      writeFileSync(full, content)
    }
    manifestPath = join(tmpRoot, 'manifest.json')
    // manifestPath is derived from mkdtemp(), not external input.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  }

  function readManifest(): SurfaceManifestEntry[] {
    // manifestPath is derived from mkdtemp(), not external input.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    return JSON.parse(readFileSync(manifestPath, 'utf-8')) as SurfaceManifestEntry[]
  }

  it('without --write, behavior (output, exit code, no file writes) is unchanged (AC-1, AC-9)', () => {
    makeFixture({ [ROUTES_TS_PATH]: `await verifyUserPassword(a, b)\n` }, [makeWriteTestEntry()])
    const before = readFileSync(manifestPath, 'utf-8')

    const result = runCheckOnly(manifestPath, tmpRoot)

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('verified against the live tree — OK')
    expect(readFileSync(manifestPath, 'utf-8')).toBe(before)
  })

  it('reports old->new per changed entry and a summary line, and rewrites the manifest (AC-3, AC-7)', () => {
    makeFixture(
      { [ROUTES_TS_PATH]: `\n\nawait verifyUserPassword(a, b)\n` }, // hit now on line 3
      [makeWriteTestEntry({ line: 1 })] // stale — pretend an insertion shifted this down to line 3
    )

    const result = runWrite(manifestPath, tmpRoot)

    expect(result.stdout).toContain(`${ROUTES_TS_PATH}:1 (${WRITE_TEST_P1}) -- line 1 -> 3`)
    expect(result.stdout).toContain('1 entries regenerated, 0 groups left unresolved')
    expect(result.exitCode).toBe(0)
    const [regeneratedEntry] = readManifest()
    expect(regeneratedEntry?.line).toBe(3)
    // every other field is preserved untouched
    expect(regeneratedEntry).toMatchObject(makeWriteTestEntry({ line: 3 }))
  })

  it('a re-run without --write against the rewritten manifest reports zero failures (AC-6)', () => {
    makeFixture({ [ROUTES_TS_PATH]: `\n\nawait verifyUserPassword(a, b)\n` }, [
      makeWriteTestEntry(),
    ])

    runWrite(manifestPath, tmpRoot)
    const recheck = runCheckOnly(manifestPath, tmpRoot)

    expect(recheck.exitCode).toBe(0)
    expect(recheck.stdout).toContain('OK')
  })

  it('running --write twice with no source changes makes no further changes (AC-8)', () => {
    makeFixture({ [ROUTES_TS_PATH]: `\n\nawait verifyUserPassword(a, b)\n` }, [
      makeWriteTestEntry(),
    ])

    runWrite(manifestPath, tmpRoot)
    const afterFirst = readFileSync(manifestPath, 'utf-8')
    const second = runWrite(manifestPath, tmpRoot)

    expect(second.stdout).toContain('0 entries regenerated, 0 groups left unresolved')
    expect(readFileSync(manifestPath, 'utf-8')).toBe(afterFirst)
  })

  it('produces byte-identical file output for an already-correct manifest+tree (formatting fidelity)', () => {
    makeFixture({ [ROUTES_TS_PATH]: `await verifyUserPassword(a, b)\n` }, [makeWriteTestEntry()])
    const before = readFileSync(manifestPath, 'utf-8')

    const result = runWrite(manifestPath, tmpRoot)

    expect(result.stdout).toContain('0 entries regenerated')
    expect(readFileSync(manifestPath, 'utf-8')).toBe(before)
  })

  it('a group-size mismatch leaves the manifest untouched and reports the underlying failure (AC-4)', () => {
    makeFixture(
      { [ROUTES_TS_PATH]: `await verifyUserPassword(a, b)\nawait verifyUserPassword(c, d)\n` },
      [makeWriteTestEntry()]
    )
    const before = readFileSync(manifestPath, 'utf-8')

    const result = runWrite(manifestPath, tmpRoot)

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain('0 entries regenerated, 1 groups left unresolved')
    expect(result.stderr).toContain('unlisted native-credential path')
    expect(readFileSync(manifestPath, 'utf-8')).toBe(before)
  })
})
