// Story 68.23 AC-2: the pure parts of the shipped-form route audit proof. The Docker call itself is
// exercised by `make mock-ui-pack-e2e`; here the cases, the argv and the exit-code checks are pinned
// so the proof cannot pass vacuously.
import { describe, expect, it } from 'vitest'
import {
  type AuditCase,
  AUDIT_CASES,
  AUDIT_ENTRY,
  AUDIT_MOUNT,
  auditArgs,
  checkRun,
  dockerRunArgs,
  proveShippedAudit,
  staleClassificationsText,
} from './shipped-route-audit.js'

const FILES = { extracted: 'classifications.json', stale: 'stale.json' } as const
const IMAGE = 'img'
const DIR = '/tmp/a'
const EXTENSION_FLAG = '--extension'

function caseWith(exitCode: number): AuditCase {
  const found = AUDIT_CASES.find((entry) => entry.exitCode === exitCode)
  if (found === undefined) throw new Error(`no case documents exit ${String(exitCode)}`)
  return found
}
const PASS_CASE = caseWith(0)
const USAGE_CASE = caseWith(2)

describe('the shipped audit cases', () => {
  it('sample all three documented exit codes, including exactly one pass', () => {
    expect(new Set(AUDIT_CASES.map((entry) => entry.exitCode))).toEqual(new Set([0, 1, 2]))
    expect(AUDIT_CASES.filter((entry) => entry.exitCode === 0)).toHaveLength(1)
  })

  it('builds the documented invocation: node on the compiled entry, read-only mount, no network', () => {
    const argv = dockerRunArgs('img:tag', '/tmp/audit', [EXTENSION_FLAG, 'pkg'])
    expect(argv).toEqual([
      'run',
      '--rm',
      '--network',
      'none',
      '-v',
      `/tmp/audit:${AUDIT_MOUNT}:ro`,
      'img:tag',
      'node',
      AUDIT_ENTRY,
      EXTENSION_FLAG,
      'pkg',
    ])
  })

  it('points --classifications at the mounted file and omits it when a case has none', () => {
    expect(auditArgs(PASS_CASE, FILES)).toEqual([
      EXTENSION_FLAG,
      '@project-vault/mock-ui-pack',
      '--classifications',
      `${AUDIT_MOUNT}/classifications.json`,
    ])
    expect(auditArgs(USAGE_CASE, FILES)).not.toContain('--classifications')
  })

  it('writes a stale classification for a route that does not exist', () => {
    const entries = JSON.parse(staleClassificationsText()) as Array<{ route: string }>
    expect(entries).toHaveLength(1)
    expect(entries[0]?.route).toMatch(/^GET \//)
  })
})

describe('checkRun', () => {
  it('accepts exactly the documented exit code and text', () => {
    const run = { status: 0, stdout: 'route audit: PASS\n', stderr: '' }
    expect(checkRun(PASS_CASE, run)).toEqual([])
  })

  it('reports a wrong exit code and missing text', () => {
    const failed = checkRun(PASS_CASE, { status: 1, stdout: 'route audit: FAIL', stderr: '' })
    expect(failed).toHaveLength(2)
    expect(checkRun(PASS_CASE, { status: null, stdout: '', stderr: '' }).join()).toContain(
      'got null'
    )
  })

  it('requires a usage error to print nothing on stdout', () => {
    const output = {
      status: 2,
      stdout: 'route audit: PASS',
      stderr: USAGE_CASE.mustContain.join('\n'),
    }
    expect(checkRun(USAGE_CASE, output).join()).toContain('nothing on stdout')
  })
})

describe('proveShippedAudit', () => {
  it('runs every case once and returns no problem when each behaves as documented', () => {
    const seen: string[][] = []
    const problems = proveShippedAudit(IMAGE, DIR, FILES, (argv) => {
      seen.push(argv)
      const matched = AUDIT_CASES.find(
        (entry) => argv.join(' ') === dockerRunArgs(IMAGE, DIR, auditArgs(entry, FILES)).join(' ')
      )
      return {
        status: matched?.exitCode ?? null,
        stdout: matched?.exitCode === 2 ? '' : (matched?.mustContain.join('\n') ?? ''),
        stderr: matched?.mustContain.join('\n') ?? '',
      }
    })
    expect(problems).toEqual([])
    expect(seen).toHaveLength(AUDIT_CASES.length)
  })

  it('fails when the image cannot run the entry (exit 127, no report)', () => {
    const problems = proveShippedAudit(IMAGE, DIR, FILES, () => ({
      status: 127,
      stdout: '',
      stderr: 'Cannot find module',
    }))
    expect(problems.length).toBeGreaterThanOrEqual(AUDIT_CASES.length)
  })
})
