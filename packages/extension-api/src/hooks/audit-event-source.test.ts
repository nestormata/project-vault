import { describe, expect, it } from 'vitest'
import type {
  AuditEventSourceHost,
  AuditEventSourceWriteInput,
  AuditEventSourceWriteResult,
} from './audit-event-source.js'

const FIXTURE_EVENT_TYPE = 'ext.com.acme.fixture.event_happened'

describe('AuditEventSourceWriteInput / AuditEventSourceWriteResult — exact-shape tests (AC-2)', () => {
  it('AuditEventSourceWriteResult has exactly id/createdAt — no keyVersion, no hmac (AC-10)', () => {
    const fixture: AuditEventSourceWriteResult = { id: 'row_1', createdAt: '2026-08-17T00:00:00Z' }
    expect(new Set(Object.keys(fixture))).toEqual(new Set(['id', 'createdAt']))
  })

  it('AuditEventSourceWriteInput accepts the full optional shape with no actorTokenId field', () => {
    const fixture: AuditEventSourceWriteInput = {
      eventType: FIXTURE_EVENT_TYPE,
      orgId: 'org_1',
      projectId: 'project_1',
      resourceId: 'resource_1',
      resourceType: 'widget',
      payload: { foo: 'bar' },
    }
    expect(new Set(Object.keys(fixture))).toEqual(
      new Set(['eventType', 'orgId', 'projectId', 'resourceId', 'resourceType', 'payload'])
    )
  })

  it('AuditEventSourceWriteInput accepts the minimal required shape', () => {
    const fixture: AuditEventSourceWriteInput = {
      eventType: FIXTURE_EVENT_TYPE,
      orgId: 'org_1',
      payload: {},
    }
    expect(fixture.eventType).toBe(FIXTURE_EVENT_TYPE)
  })
})

describe('AuditEventSourceHost — the inverted hook shape (AC-2)', () => {
  it('typechecks and returns a Promise<AuditEventSourceWriteResult>', async () => {
    const host: AuditEventSourceHost = {
      writeAuditEvent: async (_input) => ({
        id: 'row_1',
        createdAt: new Date().toISOString(),
      }),
    }
    const result = await host.writeAuditEvent({
      eventType: 'ext.com.acme.foo.bar',
      orgId: 'org_1',
      payload: {},
    })
    expect(new Set(Object.keys(result))).toEqual(new Set(['id', 'createdAt']))
  })
})
