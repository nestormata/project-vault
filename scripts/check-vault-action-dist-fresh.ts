#!/usr/bin/env tsx
/**
 * D6/AC-11 — `packages/vault-action/dist/index.js` is the only committed `dist/` in this
 * monorepo: it is the literal artifact GitHub Actions checks out and executes for every consumer
 * of `uses: project-vault/vault-action@v1`, since the Actions runtime never runs an install step.
 * This mirrors the existing `generate-spec`/`openapi.json` "committed generated artifact must
 * match its generator's output" discipline (`turbo.json`'s `typecheck` task already
 * `dependsOn: ["generate-spec"]`), applied to this repo's second instance of that pattern.
 *
 * Rebuilds the package into a throwaway temp directory and byte-compares the result against the
 * committed `dist/`, rather than rebuilding in place and using `git diff` — a stale tag could
 * otherwise still pass a "does `git diff` show changes" check locally after a contributor
 * manually reverted an uncommitted rebuild, whereas comparing against a truly independent fresh
 * build has no such blind spot.
 *
 * Empirically verified at story-implementation time: two consecutive `ncc` builds of this
 * package's unmodified source produce byte-identical `dist/index.js`/`dist/index.js.map` output
 * (no embedded absolute paths, timestamps, or other non-reproducible content) — so a full,
 * unmodified byte-for-byte directory comparison is reliable here and is not a flaky check.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const VAULT_ACTION_PACKAGE_DIR = 'packages/vault-action'

function walk(root: string, currentDir: string, out: string[]): void {
  for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
    const fullPath = join(currentDir, entry.name)
    if (entry.isDirectory()) {
      walk(root, fullPath, out)
    } else {
      out.push(relative(root, fullPath))
    }
  }
}

export function listFilesRecursively(root: string): string[] {
  if (!existsSync(root)) return []
  const out: string[] = []
  walk(root, root, out)
  return out.sort()
}

/**
 * Byte-compares two directory trees (e.g. the committed `dist/` and a fresh rebuild of it) and
 * returns a human-readable list of every difference found (missing/extra/changed files) — empty
 * when the two trees are identical.
 */
export function compareDistDirectories(committedDir: string, freshDir: string): string[] {
  const committedFiles = new Set(listFilesRecursively(committedDir))
  const freshFiles = new Set(listFilesRecursively(freshDir))
  const allFiles = new Set([...committedFiles, ...freshFiles])
  const diffs: string[] = []

  for (const file of allFiles) {
    if (!committedFiles.has(file)) {
      diffs.push(`${file}: present in a fresh rebuild but missing from the committed dist/`)
      continue
    }
    if (!freshFiles.has(file)) {
      diffs.push(`${file}: present in the committed dist/ but missing from a fresh rebuild`)
      continue
    }
    const committedContent = readFileSync(join(committedDir, file))
    const freshContent = readFileSync(join(freshDir, file))
    if (!committedContent.equals(freshContent)) {
      diffs.push(`${file}: content differs between the committed dist/ and a fresh rebuild`)
    }
  }

  return diffs.sort()
}

/**
 * Rebuilds `packages/vault-action` into `outDir` instead of its normal `dist/` location. The ncc
 * flags below must be kept in sync with `packages/vault-action/package.json`'s own `build` script.
 */
export function buildFreshDist(repoRoot: string, outDir: string): void {
  execFileSync(
    'pnpm',
    [
      '--filter',
      '@project-vault/vault-action',
      'exec',
      'ncc',
      'build',
      'src/index.ts',
      '-o',
      outDir,
      '--minify=false',
      '--source-map',
      '--license',
      'licenses.txt',
    ],
    { cwd: repoRoot, stdio: 'inherit' }
  )
}

function report(diffs: string[]): void {
  if (diffs.length === 0) {
    process.stdout.write(
      'check-vault-action-dist-fresh: packages/vault-action/dist/index.js is up to date — OK\n'
    )
    return
  }
  process.stderr.write(
    "FATAL: packages/vault-action/dist/index.js is stale — run 'pnpm --filter vault-action build' and commit the result:\n"
  )
  for (const diff of diffs) process.stderr.write(`  - ${diff}\n`)
  process.exitCode = 1
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const repoRoot = process.cwd()
  const committedDir = resolve(repoRoot, VAULT_ACTION_PACKAGE_DIR, 'dist')
  const tmpDir = mkdtempSync(join(tmpdir(), 'vault-action-dist-fresh-'))
  try {
    buildFreshDist(repoRoot, tmpDir)
    report(compareDistDirectories(committedDir, tmpDir))
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
}
