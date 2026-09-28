import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { scanStoryReferences } from './check-story-references.js'
import {
  runScriptCli,
  useFixtureRoots,
  writeFixture,
  writeFixtureSymlink,
} from './lib/fixture-test-helpers.js'
import {
  extractFrontmatterStatus,
  parseDevelopmentStatus,
  parseDevelopmentStatusEntries,
  scanStoryStatusSync,
} from './check-story-status-sync.js'

const ARTIFACTS_DIR = '_bmad-output/implementation-artifacts'
const SPRINT_STATUS_PATH = `${ARTIFACTS_DIR}/sprint-status.yaml`
const SECOND_STORY_KEY = '1-2-second-story'
const SECOND_STORY_PATH = `${ARTIFACTS_DIR}/${SECOND_STORY_KEY}.md`
const SECOND_STORY_REVIEW_CONTENT = '# Story 1.2\n\nStatus: review\n'

const makeFixtureRoot = useFixtureRoots('story-status-sync-', [ARTIFACTS_DIR])

const DEVELOPMENT_STATUS_HEADER = 'development_status:\n'
const IN_PROGRESS = 'in-progress'
const RAW_REVIEW = "status: 'review'"
const RAW_DONE = "status: 'done'"
const RAW_EMPTY = "status: ''"
const RAW_IN_PROGRESS = 'status: "in-progress"'
const RAW_DONE_COMMENTED = 'status: done # closed 2026-09-27'
const FRONTMATTER_KIND = 'frontmatter-status'

const SPRINT_STATUS = `generated: 2026-05-31
last_updated: 2026-07-07
project: Fixture Project

development_status:
  # Epic 1: Fixture Epic
  epic-1: in-progress
  1-1-first-story: done
  1-2-second-story: review
  epic-1-retrospective: optional
`

describe('parseDevelopmentStatus', () => {
  it('extracts flat key: value entries from the development_status block only', () => {
    const statuses = parseDevelopmentStatus(SPRINT_STATUS)
    expect(statuses.get('1-1-first-story')).toBe('done')
    expect(statuses.get('1-2-second-story')).toBe('review')
    expect(statuses.get('epic-1')).toBe(IN_PROGRESS)
    expect(statuses.get('generated')).toBeUndefined()
  })

  it('ignores an inline comment following the value', () => {
    const statuses = parseDevelopmentStatus(
      'development_status:\n  epic-4: done # closed 2026-07-05 — retro debt confirmed resolved\n'
    )
    expect(statuses.get('epic-4')).toBe('done')
  })

  it('does not truncate the block at a column-0 "#" comment interleaved mid-block (Story 55.7 AC-6, mirrors sprint-status.yaml:765)', () => {
    const yaml =
      DEVELOPMENT_STATUS_HEADER +
      '  epic-25: done\n' +
      '  epic-25-retrospective: done\n' +
      '# last_updated: 2026-08-25 (epic-26/26-1: ...)\n' +
      '  epic-26: done\n' +
      '  26-1-first-story: done\n'

    const statuses = parseDevelopmentStatus(yaml)
    expect(statuses.get('epic-25-retrospective')).toBe('done')
    expect(statuses.get('epic-26')).toBe('done')
    expect(statuses.get('26-1-first-story')).toBe('done')
  })

  it('still terminates the block at a genuinely dedented non-comment key (edge case)', () => {
    const yaml =
      DEVELOPMENT_STATUS_HEADER +
      '  epic-1: done\n' +
      'another_top_level_key: value\n' +
      '  should-not-be-parsed: done\n'

    const statuses = parseDevelopmentStatus(yaml)
    expect(statuses.get('epic-1')).toBe('done')
    expect(statuses.get('should-not-be-parsed')).toBeUndefined()
  })

  it('is unaffected by an epic-*-gate key (Story 42.0 AC3 non-interference — parses it as a plain key/value like any other)', () => {
    const yaml =
      DEVELOPMENT_STATUS_HEADER +
      '  epic-42: in-progress\n' +
      '  epic-51-gate: blocked-on-42-4\n' +
      '  42-4-fixture-story: backlog\n'

    const statuses = parseDevelopmentStatus(yaml)
    expect(statuses.get('epic-51-gate')).toBe('blocked-on-42-4')
    expect(statuses.get('42-4-fixture-story')).toBe('backlog')
  })
})

describe('scanStoryStatusSync', () => {
  it('returns no mismatches when every story file Status: header matches sprint-status.yaml', () => {
    const root = makeFixtureRoot()
    writeFixture(root, SPRINT_STATUS_PATH, SPRINT_STATUS)
    writeFixture(root, `${ARTIFACTS_DIR}/1-1-first-story.md`, '# Story 1.1\n\nStatus: done\n')
    writeFixture(root, SECOND_STORY_PATH, SECOND_STORY_REVIEW_CONTENT)

    expect(scanStoryStatusSync(root)).toEqual([])
  })

  it('is unaffected by an epic-*-gate key present alongside tracked story files (Story 42.0 AC3 non-interference)', () => {
    const root = makeFixtureRoot()
    writeFixture(
      root,
      SPRINT_STATUS_PATH,
      SPRINT_STATUS.replace(
        DEVELOPMENT_STATUS_HEADER,
        `${DEVELOPMENT_STATUS_HEADER}  epic-51-gate: blocked-on-42-4\n  42-4-fixture-story: backlog\n`
      )
    )
    writeFixture(root, `${ARTIFACTS_DIR}/1-1-first-story.md`, '# Story 1.1\n\nStatus: done\n')
    writeFixture(root, SECOND_STORY_PATH, SECOND_STORY_REVIEW_CONTENT)

    expect(scanStoryStatusSync(root)).toEqual([])
  })

  it('flags a story file whose Status: header disagrees with sprint-status.yaml (the P6-1/P7-1/P8-1 drift)', () => {
    const root = makeFixtureRoot()
    writeFixture(root, SECOND_STORY_PATH, SECOND_STORY_REVIEW_CONTENT)
    // sprint-status.yaml already flipped this one to done, but the story file's header was never synced
    writeFixture(
      root,
      SPRINT_STATUS_PATH,
      SPRINT_STATUS.replace(`${SECOND_STORY_KEY}: review`, `${SECOND_STORY_KEY}: done`)
    )

    const mismatches = scanStoryStatusSync(root)
    expect(mismatches).toEqual([
      {
        storyKey: SECOND_STORY_KEY,
        storyFile: SECOND_STORY_PATH,
        storyStatus: 'review',
        sprintStatus: 'done',
      },
    ])
  })

  it('flags a mismatch even when the Status: line carries trailing prose (Epic 23 retro regression, DW-140)', () => {
    // Established convention: "Status: review — implementation completed ..." / "Status: done
    // (targeted review complete; ...)" — the annotated form, not just the bare word. The prior
    // end-of-line-anchored regex silently produced no match at all for lines like this, hiding
    // real drift (found live on 23-5: a stale `Status: review — ...` header sitting undetected
    // against a `done` sprint-status.yaml entry).
    const root = makeFixtureRoot()
    writeFixture(
      root,
      SECOND_STORY_PATH,
      '# Story 1.2\n\nStatus: review — implementation completed 2026-08-19 after Story 1.1.\n'
    )
    writeFixture(
      root,
      SPRINT_STATUS_PATH,
      SPRINT_STATUS.replace(`${SECOND_STORY_KEY}: review`, `${SECOND_STORY_KEY}: done`)
    )

    const mismatches = scanStoryStatusSync(root)
    expect(mismatches).toEqual([
      {
        storyKey: SECOND_STORY_KEY,
        storyFile: SECOND_STORY_PATH,
        storyStatus: 'review',
        sprintStatus: 'done',
      },
    ])
  })

  it('matches cleanly when an annotated Status: line agrees with sprint-status.yaml', () => {
    const root = makeFixtureRoot()
    writeFixture(root, SPRINT_STATUS_PATH, SPRINT_STATUS)
    writeFixture(
      root,
      `${ARTIFACTS_DIR}/1-1-first-story.md`,
      '# Story 1.1\n\nStatus: done (targeted review and quality gate complete; a residual gap remains externally unexercised)\n'
    )
    writeFixture(root, SECOND_STORY_PATH, SECOND_STORY_REVIEW_CONTENT)

    expect(scanStoryStatusSync(root)).toEqual([])
  })

  it('ignores files with no matching sprint-status.yaml key (adversarial-review docs, retros, deferred-work.md)', () => {
    const root = makeFixtureRoot()
    writeFixture(root, SPRINT_STATUS_PATH, SPRINT_STATUS)
    writeFixture(root, `${ARTIFACTS_DIR}/1-1-first-story-adversarial-review.md`, 'Status: review\n')
    writeFixture(root, `${ARTIFACTS_DIR}/epic-1-retro-2026-07-01.md`, 'Status: n/a\n')
    writeFixture(root, `${ARTIFACTS_DIR}/deferred-work.md`, '# Deferred Work\n')

    expect(scanStoryStatusSync(root)).toEqual([])
  })

  it('returns no mismatches when sprint-status.yaml does not exist', () => {
    const root = makeFixtureRoot()
    expect(scanStoryStatusSync(root)).toEqual([])
  })

  it('follows a symlinked story file and checks it like a regular one (Story 55.7 AC-1)', () => {
    const root = makeFixtureRoot()
    writeFixture(root, SPRINT_STATUS_PATH, SPRINT_STATUS)
    writeFixture(root, `targets/${SECOND_STORY_KEY}.md`, SECOND_STORY_REVIEW_CONTENT)
    writeFixtureSymlink(root, SECOND_STORY_PATH, join(root, 'targets', `${SECOND_STORY_KEY}.md`))

    expect(scanStoryStatusSync(root)).toEqual([])
  })

  it('flags a mismatch in a symlinked story file the same as a plain one (Story 55.7 AC-1)', () => {
    const root = makeFixtureRoot()
    writeFixture(
      root,
      SPRINT_STATUS_PATH,
      SPRINT_STATUS.replace(`${SECOND_STORY_KEY}: review`, `${SECOND_STORY_KEY}: done`)
    )
    writeFixture(root, `targets/${SECOND_STORY_KEY}.md`, SECOND_STORY_REVIEW_CONTENT)
    writeFixtureSymlink(root, SECOND_STORY_PATH, join(root, 'targets', `${SECOND_STORY_KEY}.md`))

    expect(scanStoryStatusSync(root)).toEqual([
      {
        storyKey: SECOND_STORY_KEY,
        storyFile: SECOND_STORY_PATH,
        storyStatus: 'review',
        sprintStatus: 'done',
      },
    ])
  })

  it('reports a dangling symlink as its own violation kind, distinct from a status mismatch (Story 55.7 AC-2)', () => {
    const root = makeFixtureRoot()
    writeFixture(root, SPRINT_STATUS_PATH, SPRINT_STATUS)
    writeFixtureSymlink(root, SECOND_STORY_PATH, join(root, ARTIFACTS_DIR, 'does-not-exist.md'))

    const violations = scanStoryStatusSync(root)
    expect(violations).toEqual([
      {
        file: SECOND_STORY_PATH,
        reason: 'dangling-symlink',
        target: join(root, ARTIFACTS_DIR, 'does-not-exist.md'),
      },
    ])
  })
})

describe('scanStoryStatusSync — named historical-incident regression fixtures (Story 1.13 AC-P2)', () => {
  it('CP4-4 (Epic 4 retro, 2026-07-03): a story file stuck at review while sprint-status.yaml already says done', () => {
    const root = makeFixtureRoot()
    const key = '4-1-team-invitations-and-role-assignment'
    writeFixture(root, SPRINT_STATUS_PATH, `development_status:\n  ${key}: done\n`)
    writeFixture(root, `${ARTIFACTS_DIR}/${key}.md`, `# Story 4.1\n\nStatus: review\n`)

    expect(scanStoryStatusSync(root)).toEqual([
      {
        storyKey: key,
        storyFile: `${ARTIFACTS_DIR}/${key}.md`,
        storyStatus: 'review',
        sprintStatus: 'done',
      },
    ])
  })

  it('A6-3 (Epic 6 retro, 2026-07-06): multiple story files simultaneously stuck at review while sprint-status.yaml says done', () => {
    const root = makeFixtureRoot()
    const keys = [
      '6-1-service-certificate-and-domain-record-management',
      '6-2-http-endpoint-monitoring-and-availability-alerts',
      '7-1-machine-user-identity-and-api-key-management',
    ]
    const sprintStatusLines = keys.map((key) => `  ${key}: done`).join('\n')
    writeFixture(root, SPRINT_STATUS_PATH, `development_status:\n${sprintStatusLines}\n`)
    for (const key of keys) {
      writeFixture(root, `${ARTIFACTS_DIR}/${key}.md`, `# Story\n\nStatus: review\n`)
    }

    const mismatches = scanStoryStatusSync(root)
    expect(mismatches).toHaveLength(3)
    for (const key of keys) {
      expect(mismatches).toContainEqual({
        storyKey: key,
        storyFile: `${ARTIFACTS_DIR}/${key}.md`,
        storyStatus: 'review',
        sprintStatus: 'done',
      })
    }
  })

  it('Epic 8 "5th recurrence" (8-7, caught during its own post-implementation code review): a single story file stuck at review while sprint-status.yaml says done', () => {
    const root = makeFixtureRoot()
    const key = '8-7-epic-8-completion-audit-compliance-web-ui-and-technical-debt'
    writeFixture(root, SPRINT_STATUS_PATH, `development_status:\n  ${key}: done\n`)
    writeFixture(root, `${ARTIFACTS_DIR}/${key}.md`, `# Story 8.7\n\nStatus: review\n`)

    expect(scanStoryStatusSync(root)).toEqual([
      {
        storyKey: key,
        storyFile: `${ARTIFACTS_DIR}/${key}.md`,
        storyStatus: 'review',
        sprintStatus: 'done',
      },
    ])
  })
})

describe('scanStoryStatusSync against the real repository', () => {
  it('passes with zero mismatches against every story file currently committed', () => {
    expect(scanStoryStatusSync(process.cwd())).toEqual([])
  })
})

describe('Story 55.7 AC-4 — the fixed walker makes both guards actually fail on a seeded violation', () => {
  const AC4_ARTIFACTS_DIR = '_bmad-output/implementation-artifacts'
  const AC4_SPRINT_STATUS_PATH = `${AC4_ARTIFACTS_DIR}/sprint-status.yaml`
  const AC4_KEY = '9-1-seeded-symlinked-story'
  const AC4_STORY_PATH = `${AC4_ARTIFACTS_DIR}/${AC4_KEY}.md`
  const AC4_SPRINT_STATUS = 'development_status:\n  9-1-seeded-symlinked-story: done\n'

  const makeAc4FixtureRoot = useFixtureRoots('story-ac4-', [AC4_ARTIFACTS_DIR])

  it('a seeded symlinked story file with a mismatched Status: header and a dangling "Story X.Y" reference fails both guards; the reconciled record passes both', () => {
    const root = makeAc4FixtureRoot()
    writeFixture(root, AC4_SPRINT_STATUS_PATH, AC4_SPRINT_STATUS)
    writeFixture(
      root,
      `targets/${AC4_KEY}.md`,
      '# Story 9.1\n\nStatus: review\n\nDeferred to Story 13.5.\n'
    )
    writeFixtureSymlink(root, AC4_STORY_PATH, join(root, 'targets', `${AC4_KEY}.md`))

    // Seeded: the symlinked file's `Status: review` disagrees with sprint-status.yaml's `done`,
    // and it forward-references a "Story 13.5" that has no sprint-status.yaml entry.
    expect(scanStoryStatusSync(root)).toEqual([
      {
        storyKey: AC4_KEY,
        storyFile: AC4_STORY_PATH,
        storyStatus: 'review',
        sprintStatus: 'done',
      },
    ])
    expect(scanStoryReferences(root)).toEqual([
      {
        storyKey: AC4_KEY,
        storyFile: AC4_STORY_PATH,
        referencedStory: 'Story 13.5',
      },
    ])

    // Reconciled: fix the symlink target's content in place (real symlink still points at the
    // same target — this mirrors how a maintainer would actually reconcile a real symlinked
    // story file: edit the target, not the link).
    writeFixture(root, `targets/${AC4_KEY}.md`, '# Story 9.1\n\nStatus: done\n')

    expect(scanStoryStatusSync(root)).toEqual([])
    expect(scanStoryReferences(root)).toEqual([])
  })
})

describe('parseDevelopmentStatusEntries (Story 43.11 Task 1.1)', () => {
  it('returns every entry with its 1-based line number, keeping duplicates in file order', () => {
    const yaml =
      'generated: x\n' +
      DEVELOPMENT_STATUS_HEADER +
      '  epic-43: in-progress # 7/7 done\n' +
      '# last_updated: 2026-09-27 (interleaved)\n' +
      '  epic-43-retrospective: optional\n' +
      '  epic-43-retrospective: done\n' +
      'other: x\n' +
      '  ignored-key: done\n'
    expect(parseDevelopmentStatusEntries(yaml)).toEqual([
      { key: 'epic-43', value: 'in-progress', line: 3 },
      { key: 'epic-43-retrospective', value: 'optional', line: 5 },
      { key: 'epic-43-retrospective', value: 'done', line: 6 },
    ])
  })

  it('parseDevelopmentStatus stays the last-wins Map view over the same entries', () => {
    const yaml = DEVELOPMENT_STATUS_HEADER + '  a-1-x: optional\n  a-1-x: done\n'
    expect(parseDevelopmentStatus(yaml).get('a-1-x')).toBe('done')
  })
})

describe('extractFrontmatterStatus (Story 43.11 AC-3 parsing contract)', () => {
  it.each([
    ["---\ntitle: 'x'\nstatus: 'review'\n---\n", RAW_REVIEW, 'review', 3],
    ['---\nstatus: "in-progress"\n---\n', RAW_IN_PROGRESS, IN_PROGRESS, 2],
    ['---\nstatus: done\n---\n', 'status: done', 'done', 2],
    [`---\n${RAW_DONE_COMMENTED}\n---\n`, RAW_DONE_COMMENTED, 'done', 2],
    [
      "---\nstatus: 'done'  # closed 2026-09-27\n---\n",
      "status: 'done'  # closed 2026-09-27",
      'done',
      2,
    ],
    ["---\nstatus: 'review' # was done\n---\n", "status: 'review' # was done", 'review', 2],
    ["---\nstatus: 'it''s'\n---\n", "status: 'it''s'", "it's", 2],
    ["---\nstatus: 'done\n---\n", "status: 'done", 'done', 2],
    ['---\nstatus: >-\n  done\n---\n', 'status: >-', '>-', 2],
    ['---\nstatus:\n---\n', 'status:', '', 2],
    ["---\nstatus: ''\n---\n", RAW_EMPTY, '', 2],
  ])('parses %j', (content, raw, value, line) => {
    expect(extractFrontmatterStatus(content)).toEqual({ raw, value, line })
  })

  it('returns undefined without frontmatter, without a status key, or with an unterminated block', () => {
    expect(extractFrontmatterStatus('# Story\n\nStatus: done\n')).toBeUndefined()
    expect(extractFrontmatterStatus("---\ntitle: 'x'\n---\nStatus: done\n")).toBeUndefined()
    expect(extractFrontmatterStatus("---\nstatus: 'review'\n# Story\n")).toBeUndefined()
  })

  it('ignores an indented nested status: and reads only the top-level key', () => {
    expect(
      extractFrontmatterStatus("---\ncontext:\n  status: review\nstatus: 'done'\n---\n")
    ).toEqual({ raw: RAW_DONE, value: 'done', line: 4 })
  })

  it('does not treat a later Markdown horizontal rule as frontmatter', () => {
    expect(extractFrontmatterStatus('# Story\n\n---\nstatus: review\n---\n')).toBeUndefined()
  })

  it('takes only the first top-level status: line', () => {
    expect(extractFrontmatterStatus('---\nstatus: review\nstatus: done\n---\n')?.value).toBe(
      'review'
    )
  })

  it('tolerates a UTF-8 BOM and CRLF line endings, keeping whole-file line numbers', () => {
    expect(extractFrontmatterStatus("﻿---\r\ntitle: x\r\nstatus: 'review'\r\n---\r\n")).toEqual({
      raw: RAW_REVIEW,
      value: 'review',
      line: 3,
    })
  })

  it('is case-sensitive: a capitalised Status: inside frontmatter is not the frontmatter key', () => {
    expect(extractFrontmatterStatus('---\nStatus: review\n---\n')).toBeUndefined()
  })
})

describe('scanStoryStatusSync — frontmatter status: (Story 43.11 AC-3)', () => {
  const KEY = '43-2-log-in-to-the-cli-as-a-human-user'
  const FILE = `${ARTIFACTS_DIR}/${KEY}.md`
  const sprint = (status: string) => `development_status:\n  ${KEY}: ${status}\n`
  const story = (frontmatterLine: string | undefined, header: string) =>
    (frontmatterLine === undefined
      ? ''
      : `---\ntitle: 'Story 43.2: ...'\ntype: 'feature'\ncreated: '2026-09-13'\n${frontmatterLine}\n---\n\n`) +
    `# Story 43.2: ...\n\nStatus: ${header}\n`
  const frontmatterMismatch = (
    raw: string,
    frontmatterStatus: string,
    sprintStatus: string,
    headerStatus: string | undefined,
    line = 5
  ) => ({
    kind: FRONTMATTER_KIND,
    storyKey: KEY,
    storyFile: FILE,
    line,
    frontmatterRaw: raw,
    frontmatterStatus,
    sprintStatus,
    headerStatus,
  })

  it('Finding 7 (43-2, epic-43 retro): frontmatter review while header and sprint say done', () => {
    const root = makeFixtureRoot()
    writeFixture(root, SPRINT_STATUS_PATH, sprint('done'))
    writeFixture(root, FILE, story(RAW_REVIEW, 'done'))
    expect(scanStoryStatusSync(root)).toEqual([
      frontmatterMismatch(RAW_REVIEW, 'review', 'done', 'done'),
    ])
  })

  it('epic-59 Finding 3 (59-1): frontmatter review vs done is flagged', () => {
    const root = makeFixtureRoot()
    const key = '59-1-forward-actionresult-html-for-denied-and-error-outcomes'
    writeFixture(root, SPRINT_STATUS_PATH, `development_status:\n  ${key}: done\n`)
    writeFixture(root, `${ARTIFACTS_DIR}/${key}.md`, "---\nstatus: 'review'\n---\n\nStatus: done\n")
    expect(scanStoryStatusSync(root)).toMatchObject([
      { kind: FRONTMATTER_KIND, storyKey: key, frontmatterStatus: 'review', line: 2 },
    ])
  })

  it.each([RAW_DONE, 'status: "done"', 'status: done', 'status: done # closed 2026-09-27'])(
    'passes for %s',
    (line) => {
      const root = makeFixtureRoot()
      writeFixture(root, SPRINT_STATUS_PATH, sprint('done'))
      writeFixture(root, FILE, story(line, 'done'))
      expect(scanStoryStatusSync(root)).toEqual([])
    }
  )

  it('no frontmatter, or frontmatter without status:, checks only the header', () => {
    const root = makeFixtureRoot()
    writeFixture(root, SPRINT_STATUS_PATH, sprint('done'))
    writeFixture(root, FILE, story(undefined, 'done'))
    expect(scanStoryStatusSync(root)).toEqual([])
    writeFixture(root, FILE, "---\ntitle: 'x'\n---\n\nStatus: done\n")
    expect(scanStoryStatusSync(root)).toEqual([])
  })

  it('flags unquoted and double-quoted drift identically', () => {
    const root = makeFixtureRoot()
    writeFixture(root, SPRINT_STATUS_PATH, sprint('done'))
    writeFixture(root, FILE, story('status: review', 'done'))
    expect(scanStoryStatusSync(root)).toEqual([
      frontmatterMismatch('status: review', 'review', 'done', 'done'),
    ])
    writeFixture(root, SPRINT_STATUS_PATH, sprint('review'))
    writeFixture(root, FILE, story(RAW_IN_PROGRESS, 'review'))
    expect(scanStoryStatusSync(root)).toEqual([
      frontmatterMismatch(RAW_IN_PROGRESS, IN_PROGRESS, 'review', 'review'),
    ])
  })

  it('reports both kinds when header and frontmatter both drifted (neither masks the other)', () => {
    const root = makeFixtureRoot()
    writeFixture(root, SPRINT_STATUS_PATH, sprint('done'))
    writeFixture(root, FILE, story(RAW_REVIEW, 'review'))
    expect(scanStoryStatusSync(root)).toEqual([
      { storyKey: KEY, storyFile: FILE, storyStatus: 'review', sprintStatus: 'done' },
      frontmatterMismatch(RAW_REVIEW, 'review', 'done', 'review'),
    ])
  })

  it('frontmatter matches but header drifted: only the unchanged header StatusMismatch', () => {
    const root = makeFixtureRoot()
    writeFixture(root, SPRINT_STATUS_PATH, sprint('done'))
    writeFixture(root, FILE, story(RAW_DONE, 'review'))
    expect(scanStoryStatusSync(root)).toEqual([
      { storyKey: KEY, storyFile: FILE, storyStatus: 'review', sprintStatus: 'done' },
    ])
  })

  it('ignores indented nested status:, fenced status: lines, and a later horizontal rule', () => {
    const root = makeFixtureRoot()
    writeFixture(root, SPRINT_STATUS_PATH, sprint('done'))
    writeFixture(
      root,
      FILE,
      "---\ncontext:\n  status: review\nstatus: 'done'\n---\n\nStatus: done\n"
    )
    expect(scanStoryStatusSync(root)).toEqual([])
    writeFixture(
      root,
      FILE,
      '# Story\n\nStatus: done\n\n---\nstatus: review\n---\n\n```yaml\nstatus: review\n```\n'
    )
    expect(scanStoryStatusSync(root)).toEqual([])
  })

  it('unterminated frontmatter is "no frontmatter": no crash, header check still runs', () => {
    const root = makeFixtureRoot()
    writeFixture(root, SPRINT_STATUS_PATH, sprint('done'))
    writeFixture(root, FILE, "---\nstatus: 'review'\n\nStatus: review\n")
    expect(scanStoryStatusSync(root)).toEqual([
      { storyKey: KEY, storyFile: FILE, storyStatus: 'review', sprintStatus: 'done' },
    ])
  })

  it('an empty status value is drift, reported as ""', () => {
    const root = makeFixtureRoot()
    writeFixture(root, SPRINT_STATUS_PATH, sprint('done'))
    writeFixture(root, FILE, story(RAW_EMPTY, 'done'))
    expect(scanStoryStatusSync(root)).toEqual([frontmatterMismatch(RAW_EMPTY, '', 'done', 'done')])
  })

  it('parses a CRLF file and reports the correct line', () => {
    const root = makeFixtureRoot()
    writeFixture(root, SPRINT_STATUS_PATH, sprint('done'))
    writeFixture(root, FILE, "---\r\nstatus: 'review'\r\n---\r\n\r\nStatus: done\r\n")
    expect(scanStoryStatusSync(root)).toMatchObject([
      { kind: FRONTMATTER_KIND, line: 2, frontmatterStatus: 'review' },
    ])
  })

  it('ignores untracked files with drifted frontmatter (retro docs, adversarial reviews)', () => {
    const root = makeFixtureRoot()
    writeFixture(root, SPRINT_STATUS_PATH, sprint('done'))
    writeFixture(
      root,
      `${ARTIFACTS_DIR}/epic-43-retro-2026-09-27.md`,
      "---\nstatus: 'review'\n---\n"
    )
    writeFixture(root, `${ARTIFACTS_DIR}/adversarial-review-x.md`, "---\nstatus: 'review'\n---\n")
    expect(scanStoryStatusSync(root)).toEqual([])
  })

  it('follows a symlinked story file; a dangling one stays its own kind', () => {
    const root = makeFixtureRoot()
    writeFixture(root, SPRINT_STATUS_PATH, sprint('done'))
    writeFixture(root, `targets/${KEY}.md`, story(RAW_REVIEW, 'done'))
    writeFixtureSymlink(root, FILE, join(root, 'targets', `${KEY}.md`))
    expect(scanStoryStatusSync(root)).toEqual([
      frontmatterMismatch(RAW_REVIEW, 'review', 'done', 'done'),
    ])
  })

  it('pins pre-existing behaviour: a capitalised Status: inside frontmatter is read as the body header', () => {
    const root = makeFixtureRoot()
    writeFixture(root, SPRINT_STATUS_PATH, sprint('done'))
    writeFixture(root, FILE, '---\nStatus: review\n---\n\n# Story\n\nStatus: done\n')
    expect(scanStoryStatusSync(root)).toEqual([
      { storyKey: KEY, storyFile: FILE, storyStatus: 'review', sprintStatus: 'done' },
    ])
  })

  it('a story mid-transition (ready-for-dev in both places, sprint backlog) reports both kinds', () => {
    const root = makeFixtureRoot()
    writeFixture(root, SPRINT_STATUS_PATH, sprint('backlog'))
    writeFixture(root, FILE, story("status: 'ready-for-dev'", 'ready-for-dev'))
    const violations = scanStoryStatusSync(root)
    expect(violations).toHaveLength(2)
    expect(violations[1]).toMatchObject({ kind: FRONTMATTER_KIND, sprintStatus: 'backlog' })
  })
})

describe('check-story-status-sync CLI (Story 43.11 AC-3 report + AC-7 SKIPPED)', () => {
  const SCRIPT = 'scripts/check-story-status-sync.ts'
  const KEY = '43-2-log-in-to-the-cli-as-a-human-user'

  it('prints the frontmatter FATAL block with path:line and the raw quoted value, exit 1', () => {
    const root = makeFixtureRoot()
    writeFixture(root, SPRINT_STATUS_PATH, `development_status:\n  ${KEY}: done\n`)
    writeFixture(
      root,
      `${ARTIFACTS_DIR}/${KEY}.md`,
      "---\ntitle: 'Story 43.2: ...'\ntype: 'feature'\ncreated: '2026-09-13'\nstatus: 'review'\n---\n\n# Story 43.2: ...\n\nStatus: done\n"
    )
    const run = runScriptCli(SCRIPT, root)
    expect(run.status).toBe(1)
    expect(run.stderr).toContain(
      'FATAL: story file frontmatter `status:` does not match sprint-status.yaml (epic-43 retro Finding 7 / epic-59 retro Finding 3):\n' +
        `  - ${ARTIFACTS_DIR}/${KEY}.md:5: frontmatter says "${RAW_REVIEW}", sprint-status.yaml says "done" (body Status: header says "done")\n`
    )
    expect(run.stderr).toContain(
      'Fix: set the frontmatter `status:` (keep its quoting) AND the body `Status:` header to the sprint-status.yaml value, in the same edit.'
    )
    expect(run.stdout).not.toContain('OK')
  })

  it('prints SKIPPED (never OK) and exits 0 when sprint-status.yaml is absent', () => {
    const root = makeFixtureRoot()
    const run = runScriptCli(SCRIPT, root)
    expect(run.status).toBe(0)
    expect(run.stdout).toContain(
      `check-story-status-sync: SKIPPED — ${SPRINT_STATUS_PATH} not found (private overlay not attached); nothing checked`
    )
    expect(run.stdout).not.toContain('— OK')
  })

  it('prints SKIPPED with "dangling" when sprint-status.yaml is a dangling symlink, before walking dangling story links', () => {
    const root = makeFixtureRoot()
    writeFixtureSymlink(root, SPRINT_STATUS_PATH, '/nonexistent/private/sprint-status.yaml')
    writeFixtureSymlink(root, `${ARTIFACTS_DIR}/${KEY}.md`, '/nonexistent/private/story.md')
    const run = runScriptCli(SCRIPT, root)
    expect(run.status).toBe(0)
    expect(run.stdout).toContain('SKIPPED')
    expect(run.stdout).toContain('dangling')
    expect(run.stderr).toBe('')
  })

  it('code review: FATAL (never OK) when sprint-status.yaml exists but cannot be read as a file', () => {
    const root = makeFixtureRoot()
    mkdirSync(join(root, SPRINT_STATUS_PATH), { recursive: true })
    const run = runScriptCli(SCRIPT, root)
    expect(run.status).toBe(1)
    expect(run.stderr).toContain(
      `FATAL: check-story-status-sync: ${SPRINT_STATUS_PATH} cannot be read`
    )
    expect(run.stdout).not.toContain('OK')
  })

  it('still reports a dangling story-file symlink as FATAL once sprint-status.yaml is readable', () => {
    const root = makeFixtureRoot()
    writeFixture(root, SPRINT_STATUS_PATH, `development_status:\n  ${KEY}: done\n`)
    writeFixtureSymlink(root, `${ARTIFACTS_DIR}/${KEY}.md`, '/nonexistent/private/story.md')
    const run = runScriptCli(SCRIPT, root)
    expect(run.status).toBe(1)
    expect(run.stderr).toContain('dangling symlink')
  })

  it('prints OK on clean present data', () => {
    const root = makeFixtureRoot()
    writeFixture(root, SPRINT_STATUS_PATH, `development_status:\n  ${KEY}: done\n`)
    writeFixture(root, `${ARTIFACTS_DIR}/${KEY}.md`, "---\nstatus: 'done'\n---\n\nStatus: done\n")
    const run = runScriptCli(SCRIPT, root)
    expect(run.status).toBe(0)
    expect(run.stdout).toContain('— OK')
  })
})
