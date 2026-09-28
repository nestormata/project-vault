import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach } from 'vitest'

/** Registers vitest afterEach cleanup and returns a function that creates a fresh temp fixture root. */
export function useFixtureRoots(prefix: string, dirsToCreate: string[]) {
  const tempRoots: string[] = []

  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  return function makeFixtureRoot(): string {
    const root = mkdtempSync(join(tmpdir(), prefix))
    tempRoots.push(root)
    for (const dir of dirsToCreate) {
      mkdirSync(join(root, dir), { recursive: true })
    }
    return root
  }
}

export function writeFixture(root: string, relativePath: string, content: string): void {
  const fullPath = join(root, relativePath)
  mkdirSync(resolve(fullPath, '..'), { recursive: true })
  writeFileSync(fullPath, content)
}

/**
 * Creates a real symlink at `root/relativePath` pointing at `target` (an absolute path, or a path
 * relative to the symlink's own parent directory, matching `fs.symlinkSync`'s own contract). Used
 * by `walkFiles`-consuming tests (Story 55.7) that need a genuine symlink fixture rather than a
 * plain file — `writeFixture` above only ever creates regular files.
 */
export function writeFixtureSymlink(root: string, relativePath: string, target: string): void {
  const fullPath = join(root, relativePath)
  mkdirSync(resolve(fullPath, '..'), { recursive: true })
  symlinkSync(target, fullPath)
}

/** Story 43.12: creates a directory at `root/relativePath` — the "overlay input is a directory,
 * not a file → FATAL" fixture shared by the story-integrity guards' CLI tests. */
export function writeFixtureDir(root: string, relativePath: string): void {
  mkdirSync(join(root, relativePath), { recursive: true })
}

export type CliRun = { status: number | null; stdout: string; stderr: string }

/**
 * Runs a root `scripts/*.ts` guard as a real CLI (Story 43.11 AC-7): `process.execPath --import
 * <tsx loader> <realpath(script)>` with `cwd` set to a fixture root, so exit code and the
 * stdout/stderr split are asserted for real (same invocation shape as
 * check-ci-story-integrity-wiring.test.ts). `scriptRelPath` is relative to the repository root.
 */
export function runScriptCli(scriptRelPath: string, cwd: string, args: string[] = []): CliRun {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const tsxLoader = resolve(repositoryRoot, 'node_modules/tsx/dist/esm/index.mjs')
  const script = realpathSync(resolve(repositoryRoot, scriptRelPath))
  const result = spawnSync(process.execPath, ['--import', tsxLoader, script, ...args], {
    cwd,
    encoding: 'utf-8',
    stdio: 'pipe',
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}
