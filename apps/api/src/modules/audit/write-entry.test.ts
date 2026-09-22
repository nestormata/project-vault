import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  computeAuditHmac,
  GENESIS_SENTINEL,
  type AuditLogEntryHmacFields,
  type PlatformSecurityEventHmacFields,
} from './write-entry.js'

const AUDIT_KEY = Buffer.from('audit-key-for-test-audit-key-for-test')

describe('computeAuditHmac', () => {
  it('is deterministic regardless of object key insertion order', () => {
    const auditKey = AUDIT_KEY
    // Story 1.26: computeAuditHmac's fields param is no longer a bare Record<string, unknown> —
    // these fixtures were widened here to satisfy AuditHmacFields (AC-1/AC-4). The values chosen
    // don't matter for this test's assertion (key-order independence of the canonicalization),
    // only that both calls hash an equivalent fields object under different insertion orders.
    const first: AuditLogEntryHmacFields = {
      orgId: 'org-1',
      actorTokenId: null,
      actorType: 'human',
      eventType: 'USER_REGISTERED',
      payload: { b: 2, a: 1 },
      keyVersion: 1,
      previousEntryHmac: GENESIS_SENTINEL,
    }
    const second: AuditLogEntryHmacFields = {
      payload: { a: 1, b: 2 },
      eventType: 'USER_REGISTERED',
      orgId: 'org-1',
      actorTokenId: null,
      actorType: 'human',
      keyVersion: 1,
      previousEntryHmac: GENESIS_SENTINEL,
    }

    expect(computeAuditHmac(first, auditKey)).toBe(computeAuditHmac(second, auditKey))
  })

  it('uses HMAC-SHA256 over canonical sorted JSON', () => {
    const auditKey = AUDIT_KEY
    // Story 1.26: widened to the PlatformSecurityEventHmacFields shape (the smaller of the two
    // AuditHmacFields members) to satisfy the new type; the expected canonical JSON below was
    // recomputed for this fixture's fields — sortKeys/JSON.stringify/createHmac themselves are
    // unchanged (see the new dedicated regression test in this file for a fixed-input/
    // fixed-expected-output assertion against the full production field set).
    const fields: PlatformSecurityEventHmacFields = {
      eventType: 'z-event',
      subjectHash: null,
      emailDomain: null,
      payload: { first: 1 },
      keyVersion: 1,
    }
    const hmac = computeAuditHmac(fields, auditKey)
    const expected = createHmac('sha256', auditKey)
      .update(
        '{"emailDomain":null,"eventType":"z-event","keyVersion":1,"payload":{"first":1},"subjectHash":null}'
      )
      .digest('hex')

    expect(hmac).toBe(expected)
  })

  // AC-3: a fixed-input/fixed-expected-output regression test, independent of the two tests
  // above, that populates EVERY AuditLogEntryHmacFields field (including previousEntryHmac and
  // keyVersion, the two easiest to silently drop during a type-narrowing refactor). The expected
  // hex below was captured against the pre-Story-1.26 code (the original bare
  // `Record<string, unknown>`-typed computeAuditHmac) — sortKeys/JSON.stringify/createHmac are
  // byte-for-byte unchanged, so a future refactor that accidentally drops a field from the
  // canonical-JSON input (weakening Story 1.25's tamper-evidence chain) will fail this assertion.
  it('AC-3 regression: hashes every AuditLogEntryHmacFields field, matching a hardcoded pre-refactor hex digest', () => {
    const auditKey = AUDIT_KEY
    const fields: AuditLogEntryHmacFields = {
      orgId: 'org-regression-1',
      actorTokenId: 'token-regression-1',
      actorType: 'human',
      eventType: 'CREDENTIAL_CREATED',
      resourceId: 'cred-regression-1',
      resourceType: 'credential',
      payload: { name: 'Test Credential', fieldCount: 2 },
      keyVersion: 3,
      previousEntryHmac: 'abc123previoushmacvalue',
    }

    const hmac = computeAuditHmac(fields, auditKey)

    // Hardcoded HMAC-SHA256 hex digest of the fixture above under a test-only key — not a
    // credential or real secret.
    // eslint-disable-next-line no-secrets/no-secrets
    expect(hmac).toBe('6d3e5d7c84c071dfe060df6406b10f86e16846be2579f579fe6c44cca51a32d1')
  })
})
