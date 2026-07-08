import { describe, expect, it, vi } from 'vitest'
import { jsonResponse } from '$lib/test/json-response.js'
import { ApiClientError } from './client.js'
import {
  auditExportDownloadUrl,
  getAuditExportStatus,
  listAuditEvents,
  runAccessReport,
  runAccessReportCsv,
  triggerAuditExport,
  updateAuditForwarding,
  updateAuditRetention,
  verifyAuditRange,
} from './audit.js'

describe('audit API client', () => {
  describe('listAuditEvents (AC-B1/B2)', () => {
    it('calls GET /audit/events with page=1&limit=20 and no other params when no filters given', async () => {
      const fetchFn = vi
        .fn()
        .mockResolvedValue(jsonResponse({ data: [], page: 1, limit: 20, total: 0, hasNext: false }))

      await listAuditEvents(fetchFn)

      const [url] = fetchFn.mock.calls[0] as [string]
      expect(url).toBe('/api/v1/org/audit/events?page=1&limit=20')
    })

    it('includes eventType/from/to filters in the query string when provided', async () => {
      const fetchFn = vi
        .fn()
        .mockResolvedValue(jsonResponse({ data: [], page: 1, limit: 20, total: 0, hasNext: false }))

      await listAuditEvents(fetchFn, {
        eventType: 'credential.access',
        from: '2026-06-01T00:00:00.000Z',
        to: '2026-06-30T00:00:00.000Z',
      })

      const [url] = fetchFn.mock.calls[0] as [string]
      expect(url).toContain('eventType=credential.access')
      expect(url).toContain('from=2026-06-01T00%3A00%3A00.000Z')
      expect(url).toContain('to=2026-06-30T00%3A00%3A00.000Z')
    })

    it('returns page/limit/total/hasNext as siblings of the events array, not stripped by envelope unwrapping', async () => {
      const fetchFn = vi.fn().mockResolvedValue(
        jsonResponse({
          data: [{ id: '1', eventType: 'credential.access' }],
          page: 1,
          limit: 20,
          total: 340,
          hasNext: true,
        })
      )

      const result = await listAuditEvents(fetchFn)

      expect(result.total).toBe(340)
      expect(result.hasNext).toBe(true)
      expect(result.data).toHaveLength(1)
    })

    it('throws ApiClientError with the server message on a non-2xx response', async () => {
      const fetchFn = vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ code: 'forbidden', message: 'Owner role required' }, { status: 403 })
        )

      await expect(listAuditEvents(fetchFn)).rejects.toThrow(ApiClientError)
    })
  })

  describe('verifyAuditRange (AC-D1)', () => {
    it('calls GET /audit/verify?from=&to= and returns the summary payload', async () => {
      const fetchFn = vi.fn().mockResolvedValue(
        jsonResponse({
          data: {
            summary: 'All 1,247 records verified — no tampering detected',
            rowsChecked: 1247,
            passed: 1247,
            failed: [],
            failedCount: 0,
            failedTruncated: false,
            verifiedAt: '2026-07-07T00:00:00.000Z',
          },
        })
      )

      const result = await verifyAuditRange(
        fetchFn,
        '2026-06-01T00:00:00.000Z',
        '2026-06-30T00:00:00.000Z'
      )

      expect(fetchFn.mock.calls[0]?.[0]).toBe(
        '/api/v1/org/audit/verify?from=2026-06-01T00%3A00%3A00.000Z&to=2026-06-30T00%3A00%3A00.000Z'
      )
      expect(result.summary).toContain('1,247')
    })
  })

  describe('triggerAuditExport / getAuditExportStatus / auditExportDownloadUrl (AC-C1/C4)', () => {
    it('POSTs from/to/format=csv/includeIntegrityReport=true and returns the jobId', async () => {
      const fetchFn = vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ data: { jobId: 'job-1', status: 'pending' } }, { status: 202 })
        )

      const result = await triggerAuditExport(fetchFn, {
        from: '2026-06-01T00:00:00.000Z',
        to: '2026-06-30T00:00:00.000Z',
      })

      expect(fetchFn).toHaveBeenCalledWith(
        '/api/v1/org/audit/export',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            from: '2026-06-01T00:00:00.000Z',
            to: '2026-06-30T00:00:00.000Z',
            format: 'csv',
            includeIntegrityReport: true,
          }),
        })
      )
      expect(result.jobId).toBe('job-1')
    })

    it('getAuditExportStatus polls the job status endpoint', async () => {
      const fetchFn = vi.fn().mockResolvedValue(
        jsonResponse({
          data: {
            jobId: 'job-1',
            status: 'completed',
            downloadUrl: null,
            createdAt: '2026-07-07T00:00:00.000Z',
            completedAt: '2026-07-07T00:01:00.000Z',
          },
        })
      )

      const result = await getAuditExportStatus(fetchFn, 'job-1')
      expect(fetchFn.mock.calls[0]?.[0]).toBe('/api/v1/org/audit/exports/job-1')
      expect(result.status).toBe('completed')
    })

    it('auditExportDownloadUrl builds the plain-<a>-href download path per D3', () => {
      expect(auditExportDownloadUrl('job-1')).toBe('/api/v1/org/audit/exports/job-1/download')
    })
  })

  describe('updateAuditForwarding (AC-E1/E3)', () => {
    it('PUTs a webhook config', async () => {
      const fetchFn = vi
        .fn()
        .mockResolvedValue(
          jsonResponse({
            data: { type: 'webhook', enabled: true, configuredAt: '2026-07-07T14:02:00.000Z' },
          })
        )

      const result = await updateAuditForwarding(fetchFn, {
        type: 'webhook',
        config: { url: 'https://siem.example.com/ingest', secretHeader: 'wh_secret' },
      })

      expect(fetchFn).toHaveBeenCalledWith(
        '/api/v1/org/audit/forwarding',
        expect.objectContaining({ method: 'PUT' })
      )
      expect(result.configuredAt).toBe('2026-07-07T14:02:00.000Z')
    })

    it('PUTs an s3 config', async () => {
      const fetchFn = vi
        .fn()
        .mockResolvedValue(
          jsonResponse({
            data: { type: 's3', enabled: true, configuredAt: '2026-07-07T14:02:00.000Z' },
          })
        )

      await updateAuditForwarding(fetchFn, {
        type: 's3',
        config: {
          bucket: 'org-audit-logs',
          region: 'us-east-1',
          accessKeyId: 'AKIA...',
          secretAccessKey: 'secret',
        },
      })

      const [, init] = fetchFn.mock.calls[0] as [string, RequestInit]
      expect(JSON.parse(init.body as string)).toEqual({
        type: 's3',
        config: {
          bucket: 'org-audit-logs',
          region: 'us-east-1',
          accessKeyId: 'AKIA...',
          secretAccessKey: 'secret',
        },
      })
    })
  })

  describe('updateAuditRetention (AC-F1/F3)', () => {
    it('sends an explicit retentionDays: null for "retain forever"', async () => {
      const fetchFn = vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ data: { retentionDays: null, updatedAt: '2026-07-07T00:00:00.000Z' } })
        )

      await updateAuditRetention(fetchFn, null)

      const [, init] = fetchFn.mock.calls[0] as [string, RequestInit]
      expect(JSON.parse(init.body as string)).toEqual({ retentionDays: null })
    })

    it('sends a numeric retentionDays', async () => {
      const fetchFn = vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ data: { retentionDays: 400, updatedAt: '2026-07-07T00:00:00.000Z' } })
        )

      const result = await updateAuditRetention(fetchFn, 400)
      expect(result.retentionDays).toBe(400)
    })
  })

  describe('runAccessReport (AC-G1/G2)', () => {
    it('omits asOf entirely from the body when not given (fast path)', async () => {
      const fetchFn = vi.fn().mockResolvedValue(
        jsonResponse({
          data: {
            users: [],
            generatedAt: '2026-07-07T00:00:00.000Z',
            asOf: '2026-07-07T00:00:00.000Z',
            total: 0,
            page: 1,
            limit: 20,
            hasNext: false,
          },
        })
      )

      await runAccessReport(fetchFn)

      const [, init] = fetchFn.mock.calls[0] as [string, RequestInit]
      const body = JSON.parse(init.body as string)
      expect('asOf' in body).toBe(false)
      expect(body).toEqual({ page: 1, limit: 20, format: 'json' })
    })

    it('includes asOf when a historical date is given', async () => {
      const fetchFn = vi.fn().mockResolvedValue(
        jsonResponse({
          data: {
            users: [],
            generatedAt: '2026-07-07T00:00:00.000Z',
            asOf: '2026-03-01T00:00:00.000Z',
            total: 0,
            page: 1,
            limit: 20,
            hasNext: false,
          },
        })
      )

      await runAccessReport(fetchFn, { asOf: '2026-03-01T00:00:00.000Z' })

      const [, init] = fetchFn.mock.calls[0] as [string, RequestInit]
      const body = JSON.parse(init.body as string)
      expect(body.asOf).toBe('2026-03-01T00:00:00.000Z')
    })
  })

  describe('runAccessReportCsv (AC-G3)', () => {
    it('reads the response body as plain text (no {data} envelope, no Content-Disposition)', async () => {
      const csvText = 'displayName,orgRole\nDana Smith,owner\n'
      const fetchFn = vi
        .fn()
        .mockResolvedValue(
          new Response(csvText, { status: 200, headers: { 'Content-Type': 'text/csv' } })
        )

      const result = await runAccessReportCsv(fetchFn, { asOf: '2026-03-01T00:00:00.000Z' })

      expect(result).toBe(csvText)
      const [, init] = fetchFn.mock.calls[0] as [string, RequestInit]
      const body = JSON.parse(init.body as string)
      expect(body.format).toBe('csv')
    })

    it('throws ApiClientError on a non-2xx response', async () => {
      const fetchFn = vi
        .fn()
        .mockResolvedValue(
          jsonResponse(
            { code: 'invalid_as_of', message: 'This date is before your organization was created' },
            { status: 422 }
          )
        )

      await expect(runAccessReportCsv(fetchFn)).rejects.toThrow(ApiClientError)
    })
  })
})
