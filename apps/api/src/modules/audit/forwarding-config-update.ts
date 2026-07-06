import { eq } from 'drizzle-orm'
import type { Tx } from '@project-vault/db'
import { auditForwardingConfig } from '@project-vault/db/schema'

/** Shared by the webhook and S3 forwarding failure-recording paths (forwarding.ts,
 * s3-forward.ts): both persist a per-type consecutive-failure counter, flip `enabled` to false
 * once that counter crosses its own threshold, and stamp `updatedAt` — factored out here so the
 * two nearly-identical update statements aren't duplicated across the two forwarding types. */
export async function applyForwardingConfigUpdate(
  tx: Tx,
  orgId: string,
  fields: Record<string, unknown>
): Promise<void> {
  await tx
    .update(auditForwardingConfig)
    .set({ ...fields, updatedAt: new Date() })
    .where(eq(auditForwardingConfig.orgId, orgId))
}
