import { describe, it, expect } from 'vitest'
import { buildExportCsv, chunkExportRange, AUDIT_EXPORT_MAX_RANGE_DAYS } from './export.js'
import { AUDIT_VERIFY_MAX_RANGE_DAYS } from './verify.js'

const RANGE_START = '2026-01-01T00:00:00.000Z'
const SAMPLE_IP = '203.0.113.10'

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
    for (let i = 1; i < chunks.length; i += 1) {
      expect(chunks[i]?.[0]).toEqual(chunks[i - 1]?.[1])
    }
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
      'timestamp,actor_display_name,event_type,resource_id,resource_type,org_id,project_id,ip_address'
    )
    expect(lines[1]).toBe(
      '2026-07-03T14:22:01.000Z,Alice Chen,credential.value_revealed,c3d4,credential,e5f6,proj1,203.0.113.10'
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
      '2026-07-03T16:40:44.000Z,"Chen, Alice ""AC""",project.archived,,,e5f6,proj1,203.0.113.10'
    )
  })
})

describe('AUDIT_EXPORT_MAX_RANGE_DAYS', () => {
  it('is 400 days (AC-10)', () => {
    expect(AUDIT_EXPORT_MAX_RANGE_DAYS).toBe(400)
  })
})
