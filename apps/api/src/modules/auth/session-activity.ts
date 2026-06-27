import { eq } from 'drizzle-orm'
import { getDb } from '@project-vault/db'
import { sessions } from '@project-vault/db/schema'
import { env } from '../../config/env.js'

const lastActivityWrite = new Map<string, number>()

export function evictSessionActivityDebounce(sessionId: string): void {
  lastActivityWrite.delete(sessionId)
}

export async function touchSessionActivity(sessionId: string): Promise<void> {
  const now = Date.now()
  const last = lastActivityWrite.get(sessionId) ?? 0
  if (now - last < env.SESSION_ACTIVITY_DEBOUNCE_SECONDS * 1000) return
  await getDb()
    .update(sessions)
    .set({ lastActiveAt: new Date(now), updatedAt: new Date(now) })
    .where(eq(sessions.id, sessionId))
  lastActivityWrite.set(sessionId, now)
}
