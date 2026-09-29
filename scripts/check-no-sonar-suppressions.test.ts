import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { writeFixture } from './lib/fixture-test-helpers.js'
import { resolveTrustedExecutable } from './lib/trusted-executable.js'
import { findSonarSuppressions } from './check-no-sonar-suppressions.js'

// Built by concatenation so this test file never contains the token it hunts for (Story 43.9 AC-9).
const TOKEN = 'NO' + 'SONAR'
// Story 43.16 AC-6: the block Story 43.9 once accepted under Nestor's interim sign-off, verbatim
// (marker and tracking-story reference included). With TLS on the Fly internal hop it is gone, and
// the guard now rejects it like any other scanner-level ignore.
const FORMER_SIGNED_OFF_BLOCK = [
  '# AGENTS.md exception: signed off by Nestor 2026-09-27',
  '# Story 43.9, "Decisions (Nestor, 2026-09-27)" item 2.',
  '# Real fix tracked as 43-16-epic-43-completion-tls-on-the-fly-internal-api-hop.',
  'sonar.issue.ignore.multicriteria=e1',
  'sonar.issue.ignore.multicriteria.e1.ruleKey=shell:S5332',
  'sonar.issue.ignore.multicriteria.e1.resourceKey=scripts/fly-setup.sh',
]
const BASE_PROPERTIES = [
  'sonar.projectKey=example',
  'sonar.exclusions=**/node_modules/**,**/*.d.ts,packages/vault-action/dist/**',
  '',
].join('\n')
const PROPERTIES = 'sonar-project.properties'

const git = resolveTrustedExecutable('git')
function run(cwd: string, args: string[]): void {
  execFileSync(git, args, { cwd, stdio: 'ignore' })
}

const tempRoots: string[] = []
afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A throwaway git repo whose tracked files are exactly `files` (path → content). */
function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'no-sonar-suppressions-'))
  tempRoots.push(root)
  run(root, ['init', '--initial-branch=main'])
  writeFixture(root, 'README.md', 'clean\n')
  writeFixture(root, PROPERTIES, BASE_PROPERTIES)
  for (const [path, content] of Object.entries(files)) writeFixture(root, path, content)
  run(root, ['add', '-A'])
  return root
}

describe('findSonarSuppressions — inline token', () => {
  it('a clean tree passes', () => {
    expect(findSonarSuppressions(repo({ 'src/a.ts': 'export const a = 1\n' }))).toEqual([])
  })

  it('a .ts file with the token fails, naming path:line', () => {
    const root = repo({ 'src/a.ts': `export const a = 1\nexport const b = 2 // ${TOKEN}\n` })
    expect(findSonarSuppressions(root)).toEqual([
      expect.objectContaining({ location: 'src/a.ts:2' }),
    ])
  })

  it('a .sh file with a rule-qualified token fails', () => {
    const root = repo({ 'scripts/x.sh': `#!/bin/sh\nURL="http://x" # ${TOKEN}(shell:S5332)\n` })
    expect(findSonarSuppressions(root).map((f) => f.location)).toEqual(['scripts/x.sh:2'])
  })

  it('a .md file with the token fails (docs must not teach the pattern)', () => {
    const root = repo({ 'docs/guide.md': `# Guide\n\nAdd // ${TOKEN} to silence it.\n` })
    expect(findSonarSuppressions(root).map((f) => f.location)).toEqual(['docs/guide.md:3'])
  })

  it('a mixed-case variant fails (the match is case-insensitive)', () => {
    const mixedCase = 'No' + 'Sonar'
    const root = repo({ 'src/a.ts': `export const a = 1 // ${mixedCase}\n` })
    expect(findSonarSuppressions(root).map((f) => f.location)).toEqual(['src/a.ts:1'])
  })

  it('a file under an excluded vendored path (from sonar.exclusions) passes', () => {
    const root = repo({
      'packages/vault-action/dist/index.js': `// ${TOKEN}\n`,
      'types/generated.d.ts': `// ${TOKEN}\n`,
    })
    expect(findSonarSuppressions(root)).toEqual([])
  })

  it('the private overlay and tooling paths are not scanned', () => {
    const root = repo({
      '_bmad-output/story.md': `${TOKEN}\n`,
      '.claude/skills/x.md': `${TOKEN}\n`,
    })
    expect(findSonarSuppressions(root)).toEqual([])
  })
})

describe('findSonarSuppressions — workflow scanner args', () => {
  it('a workflow passing -Dsonar.issue.ignore fails', () => {
    const root = repo({
      '.github/workflows/sonar.yml': [
        'jobs:',
        '  scan:',
        '    steps:',
        '      - uses: SonarSource/sonarqube-scan-action@v5',
        '        with:',
        '          args: -Dsonar.issue.ignore.multicriteria=e1',
        '',
      ].join('\n'),
    })
    expect(findSonarSuppressions(root).map((f) => f.location)).toEqual([
      '.github/workflows/sonar.yml:6',
    ])
  })
})

describe('findSonarSuppressions — sonar-project.properties ignores', () => {
  it('a properties file with no ignore keys passes', () => {
    expect(findSonarSuppressions(repo({ [PROPERTIES]: BASE_PROPERTIES }))).toEqual([])
  })

  it('the formerly signed-off e1 block (marker and 43-16 reference included) is now rejected', () => {
    const content = [BASE_PROPERTIES, ...FORMER_SIGNED_OFF_BLOCK, ''].join('\n')
    // lines 1-3 base, 4-6 the comment, 7-9 the three ignore keys
    expect(findSonarSuppressions(repo({ [PROPERTIES]: content }))).toEqual([
      expect.objectContaining({ location: `${PROPERTIES}:7` }),
      expect.objectContaining({ location: `${PROPERTIES}:8` }),
      expect.objectContaining({ location: `${PROPERTIES}:9` }),
    ])
  })

  it('any other sonar.issue ignore/enforce key fails', () => {
    for (const key of [
      'sonar.issue.ignore.allfile=f1',
      'sonar.issue.ignore.block=b1',
      'sonar.issue.enforce.multicriteria=x1',
    ]) {
      const content = [BASE_PROPERTIES, key, ''].join('\n')
      expect(findSonarSuppressions(repo({ [PROPERTIES]: content }))).toEqual([
        expect.objectContaining({ location: `${PROPERTIES}:4` }),
      ])
    }
  })

  // java.util.Properties (which the scanner uses to load this file) also accepts a whitespace
  // key/value separator and backslash/unicode escapes inside the key; each form must still count.
  it.each([
    ['a whitespace separator', 'sonar.issue.ignore.multicriteria e9'],
    ['a tab separator', 'sonar.issue.ignore.allfile\tf1'],
    ['an escaped key character', 'sonar\\.issue.ignore.multicriteria=e9'],
    ['a unicode-escaped key character', '\\u0073onar.issue.ignore.multicriteria=e9'],
  ])('an ignore key written with %s fails', (_label, line) => {
    const content = [BASE_PROPERTIES, line, ''].join('\n')
    expect(findSonarSuppressions(repo({ [PROPERTIES]: content }))).toEqual([
      expect.objectContaining({ location: `${PROPERTIES}:4` }),
    ])
  })
})
