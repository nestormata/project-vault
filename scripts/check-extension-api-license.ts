#!/usr/bin/env tsx
/**
 * Enforces the repository's intended licensing split for `@project-vault/extension-api`:
 *
 * - the package is MIT-licensed from 3.24.2 onward: `packages/extension-api/LICENSE` is the
 *   standard MIT License text with the expected copyright line, its `package.json` declares
 *   `"license": "MIT"`, and `LICENSE` is in the package's `files` so the text ships in the tarball;
 * - the rest of Project Vault stays AGPL-3.0-or-later: the root `LICENSE` is still the GNU AGPL
 *   version 3 text and the root `package.json` declares `"license": "AGPL-3.0-or-later"`.
 *
 * This replaces the earlier `check-extension-api-license-fresh` guard, which required the package
 * LICENSE to be a byte-identical copy of the root AGPL LICENSE (the package's licence before
 * 3.24.2).
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const EXTENSION_API_DIR = 'packages/extension-api'
export const EXPECTED_COPYRIGHT_LINE = 'Copyright (c) 2026 Nestor Mata Cuthbert'

export const EXPECTED_MIT_LICENSE = `MIT License

${EXPECTED_COPYRIGHT_LINE}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`

/** Markers every copy of the GNU AGPL v3 text carries; together they identify the licence. */
export const AGPL_V3_MARKERS = [
  'GNU AFFERO GENERAL PUBLIC LICENSE',
  'Version 3, 19 November 2007',
  'TERMS AND CONDITIONS',
  '13. Remote Network Interaction; Use with the GNU General Public License.',
  'END OF TERMS AND CONDITIONS',
] as const

function normalise(text: string): string {
  return text.replaceAll('\r\n', '\n').trimEnd()
}

function readText(repoRoot: string, relativePath: string, problems: string[]): string | null {
  const fullPath = join(repoRoot, relativePath)
  if (!existsSync(fullPath)) {
    problems.push(`${relativePath}: missing`)
    return null
  }
  return readFileSync(fullPath, 'utf8')
}

function readManifest(
  repoRoot: string,
  relativePath: string,
  problems: string[]
): Record<string, unknown> | null {
  const text = readText(repoRoot, relativePath, problems)
  if (text === null) return null
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    problems.push(`${relativePath}: not a JSON object`)
  } catch {
    problems.push(`${relativePath}: not valid JSON`)
  }
  return null
}

function checkPackageLicense(repoRoot: string, problems: string[]): void {
  const path = `${EXTENSION_API_DIR}/LICENSE`
  const text = readText(repoRoot, path, problems)
  if (text !== null && normalise(text) !== normalise(EXPECTED_MIT_LICENSE)) {
    problems.push(
      `${path}: must be the standard MIT License text with the line "${EXPECTED_COPYRIGHT_LINE}"`
    )
  }
}

function checkPackageManifest(repoRoot: string, problems: string[]): void {
  const path = `${EXTENSION_API_DIR}/package.json`
  const manifest = readManifest(repoRoot, path, problems)
  if (manifest === null) return
  if (manifest.license !== 'MIT') {
    problems.push(`${path}: "license" must be "MIT", found ${JSON.stringify(manifest.license)}`)
  }
  const files = manifest.files
  if (!Array.isArray(files) || !files.includes('LICENSE')) {
    problems.push(`${path}: "files" must include "LICENSE" so the text ships`)
  }
}

function checkRootLicense(repoRoot: string, problems: string[]): void {
  const text = readText(repoRoot, 'LICENSE', problems)
  if (text === null) return
  const missing = AGPL_V3_MARKERS.filter((marker) => !text.includes(marker))
  if (missing.length > 0) {
    const list = missing.map((marker) => JSON.stringify(marker)).join(', ')
    problems.push(`LICENSE: must remain the GNU AGPL version 3 text (missing: ${list})`)
  }
}

function checkRootManifest(repoRoot: string, problems: string[]): void {
  const manifest = readManifest(repoRoot, 'package.json', problems)
  if (manifest !== null && manifest.license !== 'AGPL-3.0-or-later') {
    problems.push(
      `package.json: "license" must be "AGPL-3.0-or-later", found ${JSON.stringify(manifest.license)}`
    )
  }
}

export function findLicenseProblems(repoRoot: string): string[] {
  const problems: string[] = []
  checkPackageLicense(repoRoot, problems)
  checkPackageManifest(repoRoot, problems)
  checkRootLicense(repoRoot, problems)
  checkRootManifest(repoRoot, problems)
  return problems
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const problems = findLicenseProblems(process.cwd())
  if (problems.length === 0) {
    process.stdout.write(
      'check-extension-api-license: extension-api is MIT, the repository root stays AGPL-3.0-or-later — OK\n'
    )
  } else {
    process.stderr.write('FATAL: licensing does not match the intended extension-api/root split:\n')
    for (const problem of problems) process.stderr.write(`  - ${problem}\n`)
    process.exitCode = 1
  }
}
