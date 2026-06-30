import { expect, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { withOrg } from '@project-vault/db'
import { notificationQueue } from '@project-vault/db/schema'
import { BossService } from '../../lib/boss.js'

export function createMockBoss(): { boss: BossService; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn().mockResolvedValue('job-id')
  const boss = new BossService(() => ({
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    createQueue: vi.fn().mockResolvedValue(undefined),
    send,
  }))
  return { boss, send }
}

export async function getNotificationQueueEntry(orgId: string, queueId: string) {
  const [entry] = await withOrg(orgId, (tx) =>
    tx.select().from(notificationQueue).where(eq(notificationQueue.id, queueId))
  )
  return entry
}

export async function expectQueueStatus(
  orgId: string,
  queueId: string,
  status: 'pending' | 'delivered' | 'failed' | 'suppressed'
) {
  const entry = await getNotificationQueueEntry(orgId, queueId)
  expect(entry?.status).toBe(status)
  return entry
}
