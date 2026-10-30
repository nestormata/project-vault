import { describe, expect, it } from 'vitest'
import {
  ATTENTION_CERTIFICATE_HORIZON_DAYS,
  ATTENTION_ITEMS_PER_KIND,
  ATTENTION_SHARE_HORIZON_DAYS,
  DashboardAttentionSchema,
} from './dashboard-attention.js'

const ID = `00000000-0000-4000-8000-${'000000000001'}`
const base = { id: ID, projectId: ID, projectName: 'P', dueAt: '2026-11-01T00:00:00.000Z' }

describe('dashboard attention schema', () => {
  it('names the horizons and the per-kind cap', () => {
    expect(ATTENTION_SHARE_HORIZON_DAYS).toBe(7)
    expect(ATTENTION_CERTIFICATE_HORIZON_DAYS).toBe(30)
    expect(ATTENTION_ITEMS_PER_KIND).toBe(10)
  })

  it('accepts one item of each kind and the counts', () => {
    const value = {
      items: [
        {
          ...base,
          kind: 'expiring_share',
          credentialId: ID,
          credentialName: 'C',
          recipientEmail: null,
        },
        { ...base, kind: 'expiring_certificate', domain: 'a.example', expired: true },
        { ...base, kind: 'pending_invitation', email: 'a@b.example', roleToAssign: 'member' },
      ],
      counts: { expiringShares: 1, expiringCertificates: 1, pendingInvitations: 1 },
    }
    expect(DashboardAttentionSchema.parse(value)).toEqual(value)
  })

  it('rejects an unknown kind and a negative count', () => {
    const counts = { expiringShares: 0, expiringCertificates: 0, pendingInvitations: 0 }
    expect(() =>
      DashboardAttentionSchema.parse({ items: [{ ...base, kind: 'other' }], counts })
    ).toThrow()
    expect(() =>
      DashboardAttentionSchema.parse({ items: [], counts: { ...counts, expiringShares: -1 } })
    ).toThrow()
  })
})
