import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
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
