import { describe, expect, it } from 'vitest'
import type { AttentionItem } from '@project-vault/shared'
import { EMPTY_ATTENTION, getDashboardAttention, mergeAttention } from './attention-service.js'

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const P = uuid(170)
const cert = (id: string, dueAt: string): AttentionItem => ({
  kind: 'expiring_certificate',
  id,
  dueAt,
  projectId: P,
  projectName: 'P',
  domain: 'a.example',
  expired: false,
})
const invitation = (id: string, dueAt: string): AttentionItem => ({
  kind: 'pending_invitation',
  id,
  dueAt,
  projectId: P,
  projectName: 'P',
  email: 'a@b.example',
  roleToAssign: 'member',
})

describe('attention service', () => {
  it('orders across kinds by due date and breaks ties by id', () => {
    const merged = mergeAttention(
      [
        [cert(uuid(2), '2026-11-02T00:00:00.000Z')],
        [
          invitation(uuid(3), '2026-11-01T00:00:00.000Z'),
          invitation(uuid(1), '2026-11-02T00:00:00.000Z'),
        ],
      ],
      { expiringShares: 0, expiringCertificates: 1, pendingInvitations: 2 }
    )
    expect(merged.items.map((item) => item.id.slice(-1))).toEqual(['3', '1', '2'])
    expect(merged.counts.pendingInvitations).toBe(2)
  })

  it('answers an org viewer with the empty result before any query', async () => {
    const tx = {} as never
    const result = await getDashboardAttention(tx, {
      orgId: P,
      userId: P,
      isAdmin: false,
      isViewer: true,
    })
    expect(result).toBe(EMPTY_ATTENTION)
  })
})
