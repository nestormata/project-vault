import { existsSync, readdirSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'

export function toRepoPath(rootDir: string, file: string): string {
  return relative(rootDir, file).split(sep).join('/')
}

export function walkFiles(dir: string, predicate: (file: string) => boolean): string[] {
  if (!existsSync(dir)) return []

  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = resolve(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...walkFiles(fullPath, predicate))
    } else if (entry.isFile() && predicate(fullPath)) {
      files.push(fullPath)
    }
  }
  return files
}
