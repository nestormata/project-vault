#!/usr/bin/env tsx
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

export type Violation = { file: string; line: number; text: string }

const FORBIDDEN_COLUMN = /\b(?:value|encrypted_value|encryptedValue)\b/i
const SQL_INDEX_HINT =
  /\b(?:create\s+(?:unique\s+)?index|using\s+(?:gin|gist)|to_tsvector|gin_trgm_ops|gist_trgm_ops)\b/i
const RUNTIME_CREATE_INDEX = /\bcreate\s+(?:unique\s+)?index\b/i
const DRIZZLE_INDEX_CHAIN = /\b(?:uniqueIndex|index)\s*\([^)]*\)[\s\S]*?\.on\s*\(([\s\S]*?)\)/g

function toRepoPath(rootDir: string, file: string): string {
  return relative(rootDir, file).split(sep).join('/')
}

function lineForOffset(content: string, offset: number): number {
  return content.slice(0, offset).split('\n').length
}

function lineText(content: string, line: number): string {
  return content.split('\n')[line - 1]?.trim() ?? ''
}

function walkFiles(dir: string, predicate: (file: string) => boolean): string[] {
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

function recordViolation(
  rootDir: string,
  file: string,
  content: string,
  offset: number,
  out: Violation[]
): void {
  const line = lineForOffset(content, offset)
  out.push({ file: toRepoPath(rootDir, file), line, text: lineText(content, line) })
}

export function scanSql(rootDir: string, file: string, content: string, out: Violation[]): void {
  let offset = 0
  for (const statement of content.split(';')) {
    if (SQL_INDEX_HINT.test(statement) && FORBIDDEN_COLUMN.test(statement)) {
      recordViolation(rootDir, file, content, offset, out)
    }
    offset += statement.length + 1
  }
}

export function scanDrizzle(
  rootDir: string,
  file: string,
  content: string,
  out: Violation[]
): void {
  for (const match of content.matchAll(DRIZZLE_INDEX_CHAIN)) {
    const onArgs = match[1] ?? ''
    if (FORBIDDEN_COLUMN.test(onArgs)) {
      recordViolation(rootDir, file, content, match.index, out)
    }
  }
}

export function scanRuntimeDdl(
  rootDir: string,
  file: string,
  content: string,
  out: Violation[]
): void {
  for (const match of content.matchAll(new RegExp(RUNTIME_CREATE_INDEX, 'gi'))) {
    recordViolation(rootDir, file, content, match.index, out)
  }
}

function isTestFile(file: string): boolean {
  return (
    file.includes(`${sep}__tests__${sep}`) || file.endsWith('.test.ts') || file.endsWith('.spec.ts')
  )
}

function isMigrationFile(file: string): boolean {
  return file.includes(`${sep}packages${sep}db${sep}src${sep}migrations${sep}`)
}

export function scanSearchIndexes(rootDir = process.cwd()): Violation[] {
  const root = resolve(rootDir)
  const violations: Violation[] = []

  for (const file of walkFiles(resolve(root, 'packages/db/src/migrations'), (path) =>
    path.endsWith('.sql')
  )) {
    scanSql(root, file, readFileSync(file, 'utf8'), violations)
  }

  for (const file of walkFiles(resolve(root, 'packages/db/src/schema'), (path) =>
    path.endsWith('.ts')
  )) {
    scanDrizzle(root, file, readFileSync(file, 'utf8'), violations)
  }

  const runtimeRoots = [resolve(root, 'apps'), resolve(root, 'packages')]
  for (const runtimeRoot of runtimeRoots) {
    for (const file of walkFiles(runtimeRoot, (path) => {
      return (
        path.endsWith('.ts') &&
        path.includes(`${sep}src${sep}`) &&
        !isMigrationFile(path) &&
        !isTestFile(path)
      )
    })) {
      scanRuntimeDdl(root, file, readFileSync(file, 'utf8'), violations)
    }
  }

  return violations
}

function report(violations: Violation[]): void {
  if (violations.length === 0) {
    process.stdout.write(
      'check-search-index: no credential value indexes or runtime DDL found — OK\n'
    )
    return
  }

  process.stderr.write(
    'FATAL: search index safety violations detected — credential value columns must never be indexed and runtime CREATE INDEX is forbidden:\n'
  )
  for (const violation of violations) {
    process.stderr.write(`  - ${violation.file}:${violation.line}: ${violation.text}\n`)
  }
  process.exitCode = 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  report(scanSearchIndexes())
}
