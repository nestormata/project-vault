import { globSync } from 'node:fs'
import { join, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { findPinViolations, parseUsesRefs } from './lib/action-pins.js'

// Story 64.2 AC-3: every `uses:` ref in .github/workflows/**/*.yml and .github/actions/**/action.yml
// must be immutable. A git tag or branch can be force-moved by anyone with push rights upstream
// (the 2026-03 aquasecurity/trivy-action tag hijack), a 40-hex commit SHA cannot. Rules:
//   (a) a non-first-party (owner other than `actions`/`github`) ref must be `@<40-hex commit SHA>`;
//   (b) `@master`/`@main`/`@HEAD` is rejected for every owner, first-party included;
//   (c) a SHA pin must carry a trailing `# vX.Y.Z` / `# <tag>` comment, which Dependabot needs to
//       propose bumps and a reviewer needs to read the diff.
// Local `./` actions and `docker://` refs are exempt. First-party `actions/*`/`github/*` refs may
// stay on major tags by policy (Story 64.2 AC-6, see its Dev Notes for the rationale).

const repositoryRoot = join(import.meta.dirname, '..')

// Story 64.2 AC-2: a Trivy binary version must never be one of the TeamPCP-compromised releases.
const COMPROMISED_TRIVY_VERSIONS = new Set(['v0.69.4', 'v0.69.5', 'v0.69.6'])

// Every file the guard covers, relative to the repo root (`.github/actions/` need not exist).
const GUARDED_GLOBS = ['.github/workflows/**/*.{yml,yaml}', '.github/actions/**/action.{yml,yaml}']

// The same globs, read at transform time by Vite (vitest's module graph) as raw text. Vite needs the
// patterns as literals, so they are repeated here; `listGuardedPaths()` below is the independent
// filesystem listing the test cross-checks this against, so the two can never silently diverge.
const GUARDED_FILE_CONTENTS: Record<string, string> = import.meta.glob(
  ['../.github/workflows/**/*.{yml,yaml}', '../.github/actions/**/action.{yml,yaml}'],
  { query: '?raw', import: 'default', eager: true }
)

/** Lists every workflow and composite-action file on disk the guard covers, repo-relative. */
function listGuardedPaths(): string[] {
  return globSync(GUARDED_GLOBS, { cwd: repositoryRoot })
    .map((path) => path.split(sep).join('/'))
    .sort((a, b) => a.localeCompare(b))
}

/** Loads every workflow and composite-action file the guard covers, keyed by repo-relative path. */
function loadRepoActionFiles(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(GUARDED_FILE_CONTENTS)
      .map(([path, text]): [string, string] => [path.replace(/^\.\.\//, ''), text])
      .sort(([a], [b]) => a.localeCompare(b))
  )
}

interface TrivySite {
  file: string
  line: number
  ref: string
  version: string | undefined
}

const indentOf = (line: string): number => line.length - line.trimStart().length

/** Reads the `version:` input of the step whose `uses:` line is `lines[usesIndex]`, scanning the
 * following lines until the step ends (a dedent, or the next `- ` list item). */
function readStepVersion(lines: string[], usesIndex: number): string | undefined {
  const stepIndent = indentOf(lines.at(usesIndex) ?? '')
  for (const line of lines.slice(usesIndex + 1)) {
    if (line.trim() === '') continue
    if (indentOf(line) < stepIndent || line.trimStart().startsWith('- ')) return undefined
    const versionMatch = /^version:\s*["']?([^"'\s#]+)/.exec(line.trim())
    if (versionMatch) return versionMatch[1]
  }
  return undefined
}

/** Finds every aquasecurity/trivy-action step plus the `version:` input in that same step. */
function findTrivySites(files: Record<string, string>): TrivySite[] {
  return Object.entries(files).flatMap(([file, text]) => {
    const lines = text.split('\n')
    return parseUsesRefs(file, text)
      .filter((usesRef) => usesRef.ref.toLowerCase().startsWith('aquasecurity/trivy-action@'))
      .map((usesRef) => ({
        file,
        line: usesRef.line,
        ref: usesRef.ref,
        version: readStepVersion(lines, usesRef.line - 1),
      }))
  })
}

// Any 40-hex string is a syntactically valid pin; built rather than written out as a literal hash.
const SHA = '0123456789abcdef'.repeat(3).slice(0, 40)

describe('check-action-pins: fixture rules (Story 64.2 AC-3)', () => {
  const run = (line: string) => findPinViolations({ 'fixture.yml': `steps:\n${line}\n` })

  it('passes the cla.yml form: third-party SHA pin with a version comment', () => {
    expect(
      run(`      - uses: rdkcentral/contributor-assistant_github-action@${SHA} # v2.7.0`)
    ).toEqual([])
  })

  it('passes a sub-path action SHA pin with a non-v tag comment', () => {
    expect(run(`      - uses: superfly/flyctl-actions/setup-flyctl@${SHA} # 1.6`)).toEqual([])
  })

  it('passes first-party refs on major tags (policy, AC-6)', () => {
    expect(run('      - uses: actions/checkout@v7')).toEqual([])
    expect(run('        uses: github/codeql-action/init@v3')).toEqual([])
  })

  it('exempts local ./ actions and docker:// refs', () => {
    expect(run('      - uses: ./.github/actions/setup')).toEqual([])
    expect(run('      - uses: docker://alpine:3.20')).toEqual([])
  })

  it('(a) rejects a third-party tag ref', () => {
    const violations = run('        uses: pnpm/action-setup@v6')
    expect(violations).toHaveLength(1)
    expect(violations[0]?.reason).toMatch(/not a full 40-hex commit SHA/)
    expect(violations[0]?.line).toBe(2)
  })

  it('(a) rejects an exact third-party version tag and a short SHA', () => {
    expect(run('        uses: aquasecurity/trivy-action@v0.36.0')).toHaveLength(1)
    expect(run('        uses: aquasecurity/trivy-action@ed142fd # v0.36.0')).toHaveLength(1)
  })

  it('(a) rejects a quoted third-party tag ref', () => {
    expect(run(`        uses: "docker/login-action@v4"`)).toHaveLength(1)
  })

  it('(b) rejects @master/@main/@HEAD for third-party and first-party owners', () => {
    for (const ref of [
      'aquasecurity/trivy-action@master',
      'superfly/flyctl-actions/setup-flyctl@main',
      'actions/checkout@main',
      'github/codeql-action/init@HEAD',
    ]) {
      const violations = run(`      - uses: ${ref}`)
      expect(violations, ref).toHaveLength(1)
      expect(violations[0]?.reason, ref).toMatch(/mutable branch ref/)
    }
  })

  it('(c) rejects a SHA pin with no version comment, or a non-version comment', () => {
    for (const line of [
      `      - uses: docker/login-action@${SHA}`,
      `      - uses: docker/login-action@${SHA} # pinned`,
      `      - uses: actions/checkout@${SHA}`,
    ]) {
      const violations = run(line)
      expect(violations, line).toHaveLength(1)
      expect(violations[0]?.reason, line).toMatch(/version comment/)
    }
  })

  it('rejects a remote ref with no @ at all', () => {
    expect(run('      - uses: pnpm/action-setup')).toHaveLength(1)
  })
})

describe('check-action-pins: this repo (Story 64.2 AC-1/AC-3)', () => {
  const files = loadRepoActionFiles()

  it('finds the workflow files it is meant to guard', () => {
    // Anti-vacuity: the loaded set must be exactly what is on disk (incl. a gitignored private
    // overlay workflow when present locally), and must include the main CI workflow.
    expect(Object.keys(files)).toEqual(listGuardedPaths())
    expect(Object.keys(files)).toContain('.github/workflows/ci.yml')
    expect(parseUsesRefs('x', files['.github/workflows/ci.yml'] ?? '').length).toBeGreaterThan(0)
  })

  it('has no mutable or uncommented action refs', () => {
    const report = findPinViolations(files).map((v) => `${v.file}:${v.line} ${v.ref} — ${v.reason}`)
    expect(report).toEqual([])
  })
})

describe('check-action-pins: trivy-action consistency (Story 64.2 AC-2)', () => {
  const sites = findTrivySites(loadRepoActionFiles())

  it('pins every trivy-action site to one SHA and one explicit, non-compromised Trivy binary', () => {
    expect(sites.length).toBeGreaterThan(0)
    expect(new Set(sites.map((site) => site.ref)).size).toBe(1)
    for (const site of sites) {
      expect(site.version, `${site.file}:${site.line} has no version: input`).toMatch(
        /^v\d+\.\d+\.\d+$/
      )
      expect(COMPROMISED_TRIVY_VERSIONS.has(site.version ?? '')).toBe(false)
    }
    expect(new Set(sites.map((site) => site.version)).size).toBe(1)
  })
})
