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
const FLY_STORY = '43-16-epic-43-completion-tls-on-the-fly-internal-api-hop'
const MARKER = '# AGENTS.md exception: signed off by Nestor 2026-09-27'
const SIGNED_KEYS = [
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

function signedBlock(commentLines: string[]): string {
  return [BASE_PROPERTIES, ...commentLines, ...SIGNED_KEYS, ''].join('\n')
}

const GOOD_COMMENT = [
  MARKER,
  '# Story 43.9, "Decisions (Nestor, 2026-09-27)" item 2.',
  `# Real fix tracked as ${FLY_STORY}.`,
]

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
    const root = repo({ 'src/a.ts': `export const a = 1 // NoSonar\n` })
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
  it('the signed-off e1 block with the marker and the 43-16 reference passes', () => {
    const root = repo({ [PROPERTIES]: signedBlock(GOOD_COMMENT) })
    expect(findSonarSuppressions(root)).toEqual([])
  })

  it('the e1 block with no marker fails', () => {
    // lines 1-3 base, line 4 the comment, line 5 the first ignore key
    const root = repo({ [PROPERTIES]: signedBlock(['# a false positive, trust me']) })
    expect(findSonarSuppressions(root)).toEqual([
      expect.objectContaining({ location: `${PROPERTIES}:5` }),
    ])
  })

  it('the marker without the 43-16 reference fails', () => {
    const root = repo({ [PROPERTIES]: signedBlock([MARKER]) })
    expect(findSonarSuppressions(root)).toHaveLength(1)
  })

  it('a marker with a malformed date fails', () => {
    const comment = [
      '# AGENTS.md exception: signed off by Nestor 2026-9-27',
      `# Real fix tracked as ${FLY_STORY}.`,
    ]
    expect(findSonarSuppressions(repo({ [PROPERTIES]: signedBlock(comment) }))).toHaveLength(1)
  })

  it('a marker with an impossible calendar date fails', () => {
    const comment = [
      '# AGENTS.md exception: signed off by Nestor 2026-02-30',
      `# Real fix tracked as ${FLY_STORY}.`,
    ]
    expect(findSonarSuppressions(repo({ [PROPERTIES]: signedBlock(comment) }))).toHaveLength(1)
  })

  it('a marker placed below the keys fails', () => {
    const content = [BASE_PROPERTIES, ...SIGNED_KEYS, ...GOOD_COMMENT, ''].join('\n')
    expect(findSonarSuppressions(repo({ [PROPERTIES]: content }))).toHaveLength(1)
  })

  it('a marker separated from the keys by a blank line fails', () => {
    const content = [BASE_PROPERTIES, ...GOOD_COMMENT, '', ...SIGNED_KEYS, ''].join('\n')
    expect(findSonarSuppressions(repo({ [PROPERTIES]: content }))).toHaveLength(1)
  })

  it('the same marker with a different ruleKey fails', () => {
    const content = signedBlock(GOOD_COMMENT).replace('shell:S5332', 'typescript:S1313')
    expect(findSonarSuppressions(repo({ [PROPERTIES]: content }))).toHaveLength(1)
  })

  it('the same marker with a widened resourceKey fails', () => {
    const content = signedBlock(GOOD_COMMENT).replace('scripts/fly-setup.sh', 'scripts/**')
    expect(findSonarSuppressions(repo({ [PROPERTIES]: content }))).toHaveLength(1)
  })

  it('an extra e2 entry fails', () => {
    const content = signedBlock(GOOD_COMMENT)
      .replace('multicriteria=e1', 'multicriteria=e1,e2')
      .concat(
        [
          'sonar.issue.ignore.multicriteria.e2.ruleKey=typescript:S1313',
          'sonar.issue.ignore.multicriteria.e2.resourceKey=**/*.ts',
          '',
        ].join('\n')
      )
    expect(findSonarSuppressions(repo({ [PROPERTIES]: content })).length).toBeGreaterThan(0)
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
})
