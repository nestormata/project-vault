import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
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
