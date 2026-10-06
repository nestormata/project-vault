import { describe, it, expect } from 'vitest'
import { buildExportCsv, chunkExportRange, AUDIT_EXPORT_MAX_RANGE_DAYS } from './export.js'
import { AUDIT_VERIFY_MAX_RANGE_DAYS } from './verify.js'

const RANGE_START = '2026-01-01T00:00:00.000Z'
const SAMPLE_IP = '203.0.113.10'
const OLD_HEADER =
  'timestamp,actor_display_name,event_type,resource_id,resource_type,org_id,project_id,ip_address'

describe('chunkExportRange (AC-10)', () => {
  it('produces a single chunk for a range within the per-chunk cap', () => {
    const from = new Date(RANGE_START)
    const to = new Date('2026-01-10T00:00:00.000Z')
    const chunks = chunkExportRange(from, to, AUDIT_VERIFY_MAX_RANGE_DAYS)
    expect(chunks).toEqual([[from, to]])
  })

  it('splits a 200-day range into <= 90-day sub-ranges covering the full span with no gaps/overlaps', () => {
    const from = new Date(RANGE_START)
    const to = new Date(from.getTime() + 200 * 24 * 60 * 60 * 1000)
    const chunks = chunkExportRange(from, to, AUDIT_VERIFY_MAX_RANGE_DAYS)

    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks[0]?.[0]).toEqual(from)
    expect(chunks[chunks.length - 1]?.[1]).toEqual(to)
    for (const [chunkFrom, chunkTo] of chunks) {
      const days = (chunkTo.getTime() - chunkFrom.getTime()) / (24 * 60 * 60 * 1000)
      expect(days).toBeLessThanOrEqual(AUDIT_VERIFY_MAX_RANGE_DAYS)
    }
    // No gaps: each chunk's end matches the next chunk's start.
    expect(chunks.slice(1).map(([chunkFrom]) => chunkFrom)).toEqual(
      chunks.slice(0, -1).map(([, chunkTo]) => chunkTo)
    )
  })

  it('handles a zero-width range as a single (degenerate) chunk', () => {
    const point = new Date(RANGE_START)
    expect(chunkExportRange(point, point, AUDIT_VERIFY_MAX_RANGE_DAYS)).toEqual([[point, point]])
  })
})

describe('buildExportCsv (AC-12)', () => {
  it('produces the exact header, one row per input, and an integrity summary row', () => {
    const csv = buildExportCsv(
      [
        {
          createdAt: '2026-07-03T14:22:01.000Z',
          actorDisplayName: 'Alice Chen',
          eventType: 'credential.value_revealed',
          resourceId: 'c3d4',
          resourceType: 'credential',
          orgId: 'e5f6',
          projectId: 'proj1',
          ipAddress: SAMPLE_IP,
        },
      ],
      { rowsChecked: 1, passed: 1, failedCount: 0, verifiedAt: '2026-07-04T18:32:10.104Z' }
    )

    const lines = csv.trimEnd().split('\n')
    expect(lines[0]).toBe(
      OLD_HEADER +
        ',actor_attestation,actor_attestation_reason,actor_provider,actor_subject,occurred_at'
    )
    // Golden: a non-attributed row keeps its first eight fields byte-identical, then five empty ones.
    expect(lines[1]).toBe(
      '2026-07-03T14:22:01.000Z,Alice Chen,credential.value_revealed,c3d4,credential,e5f6,proj1,203.0.113.10,,,,,'
    )
    expect(lines[2]).toBe('--- Integrity Verification Summary ---')
    expect(lines[3]).toBe('rows_checked,1,passed,1,failed,0,verified_at,2026-07-04T18:32:10.104Z')
  })

  it('omits the summary row when no summary is provided (includeIntegrityReport: false)', () => {
    const csv = buildExportCsv(
      [
        {
          createdAt: '2026-07-03T14:22:01.000Z',
          actorDisplayName: 'Alice',
          eventType: 'project.archived',
          resourceId: null,
          resourceType: null,
          orgId: 'e5f6',
          projectId: 'proj1',
          ipAddress: SAMPLE_IP,
        },
      ],
      null
    )
    expect(csv.trimEnd().split('\n')).toHaveLength(2)
  })

  it('renders null resourceId/resourceType as empty fields, RFC 4180 quoted where needed', () => {
    const csv = buildExportCsv(
      [
        {
          createdAt: '2026-07-03T16:40:44.000Z',
          actorDisplayName: 'Chen, Alice "AC"',
          eventType: 'project.archived',
          resourceId: null,
          resourceType: null,
          orgId: 'e5f6',
          projectId: 'proj1',
          ipAddress: SAMPLE_IP,
        },
      ],
      null
    )
    const lines = csv.trimEnd().split('\n')
    expect(lines[1]).toBe(
      '2026-07-03T16:40:44.000Z,"Chen, Alice ""AC""",project.archived,,,e5f6,proj1,203.0.113.10,,,,,'
    )
  })
})

/** Minimal RFC 4180 reader so the tests can prove a file parses back to the same column count. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i)
    if (quoted) {
      if (ch === '"' && text.charAt(i + 1) === '"') {
        field += '"'
        i += 1
      } else if (ch === '"') quoted = false
      else field += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else field += ch
  }
  return rows
}

const BASE_ROW = {
  createdAt: '2026-07-03T15:00:00.000Z',
  actorDisplayName: 'extension',
  eventType: 'ext.cm.thing',
  resourceId: null,
  resourceType: null,
  orgId: 'e5f6',
  projectId: null,
  ipAddress: null,
}

describe('buildExportCsv attribution columns (71-10 AC-3)', () => {
  it('writes the three attestation classes into the five trailing columns', () => {
    const csv = buildExportCsv(
      [
        {
          ...BASE_ROW,
          attribution: {
            actor: {
              kind: 'issuer_attested',
              provider: 'workos',
              subject: 'user_1',
              reason: 'unlinked',
            },
            occurredAt: '2026-07-03T13:00:00.000Z',
            occurredAtSource: 'delegation_signed',
          },
        },
        {
          ...BASE_ROW,
          attribution: {
            actor: {
              kind: 'issuer_attested',
              provider: 'workos',
              subject: 'user_2',
              reason: 'not_current_member',
            },
          },
        },
        {
          ...BASE_ROW,
          attribution: {
            actor: { kind: 'pv_verified', provider: 'workos', subject: 'user_3', reason: null },
            occurredAt: '2026-07-03T12:00:00.000Z',
            occurredAtSource: 'extension',
          },
        },
      ],
      null
    )
    const [, ...rows] = parseCsv(csv)
    expect(rows.map((r) => r.slice(8))).toEqual([
      ['issuer_attested', 'unlinked', 'workos', 'user_1', '2026-07-03T13:00:00.000Z'],
      ['issuer_attested', 'not_current_member', 'workos', 'user_2', ''],
      ['pv_verified', '', 'workos', 'user_3', '2026-07-03T12:00:00.000Z'],
    ])
    for (const r of rows) expect(r).toHaveLength(13)
  })

  it('neutralises formula prefixes and quotes commas, quotes and CR/LF in provider and subject', () => {
    const subjects = ['=HYPERLINK("http://x","y")', '+1', '-1', '@SUM(1)', 'a,b "c"\r\nd']
    const csv = buildExportCsv(
      subjects.map((subject) => ({
        ...BASE_ROW,
        attribution: {
          actor: {
            kind: 'issuer_attested' as const,
            provider: subject,
            subject,
            reason: 'unlinked' as const,
          },
        },
      })),
      null
    )
    const [, ...rows] = parseCsv(csv)
    expect(rows).toHaveLength(subjects.length)
    const neutralised = (subject: string) => (/^[=+\-@]/.test(subject) ? `'${subject}` : subject)
    for (const r of rows) expect(r).toHaveLength(13)
    expect(rows.map((r) => r[10])).toEqual(subjects.map(neutralised))
    expect(rows.map((r) => r[11])).toEqual(subjects.map(neutralised))
  })
})

describe('AUDIT_EXPORT_MAX_RANGE_DAYS', () => {
  it('is 400 days (AC-10)', () => {
    expect(AUDIT_EXPORT_MAX_RANGE_DAYS).toBe(400)
  })
})

// Story 15.1 AC 5 — audit exports stay locale-invariant (English text, ISO 8601 dates)
// regardless of the requesting/actor user's `users.locale` value. buildExportCsv()'s row shape
// (ExportCsvRow / the row param above) has no locale field at all and never reads one, so this
// is a structural regression test: byte-identical output for two "requests" that differ only in
// an out-of-band locale value that is never passed into the function in the first place.
describe('buildExportCsv locale-invariance (AC 5)', () => {
  it('produces byte-identical output regardless of any out-of-band user locale', () => {
    const localeInvarianceTimestamp = '2026-07-09T09:11:02.000Z'
    const rows = [
      {
        createdAt: localeInvarianceTimestamp,
        actorDisplayName: 'Alice Chen',
        eventType: 'credential.value_revealed',
        resourceId: 'c3d4',
        resourceType: 'credential',
        orgId: 'e5f6',
        projectId: 'proj1',
        ipAddress: SAMPLE_IP,
      },
    ]
    const summary = {
      rowsChecked: 1,
      passed: 1,
      failedCount: 0,
      verifiedAt: '2026-07-09T09:12:00.000Z',
    }

    // buildExportCsv's signature has no locale parameter to pass — this simulates "a user with
    // locale es" and "a user with locale en" triggering the same export by simply calling the
    // function twice with identical row/summary input (there is no locale input to vary).
    const csvForEsUser = buildExportCsv(rows, summary)
    const csvForEnUser = buildExportCsv(rows, summary)

    expect(csvForEsUser).toBe(csvForEnUser)
    // Dates stay ISO 8601 and text stays English/untranslated regardless of locale.
    expect(csvForEsUser).toContain(localeInvarianceTimestamp)
    expect(csvForEsUser).not.toMatch(/[áéíóúñ¿¡]/i)
  })
})
