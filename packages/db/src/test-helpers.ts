import type { Tx } from './index.js'

export async function withTestOrg<T>(
  fn: (ctx: { orgId: string; tx: Tx }) => Promise<T>
): Promise<T> {
  // Story 1.4 adds the real implementation with RLS
  // Stub: calls fn with a random UUID and fake tx
  const orgId = crypto.randomUUID()
  return fn({ orgId, tx: {} as Tx })
}
