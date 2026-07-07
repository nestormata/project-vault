import { and, eq, inArray } from 'drizzle-orm'
import type { Tx } from '@project-vault/db'
import { dataErasureRequests } from '@project-vault/db/schema'
import { getAdminDb } from '../../lib/db.js'
import { hashOriginalEmail } from './erasure-service.js'

const BLOCKING_STATUSES = ['pending', 'in_progress', 'completed'] as const

/**
 * D6 (AC-17): invitation creation is already org-scoped (secureCtx.tx carries RLS for the
 * calling org), so this reuses that same transaction/context — no admin connection needed here.
 */
export async function findErasedRequestForEmailInOrg(
  tx: Tx,
  orgId: string,
  email: string
): Promise<{ requestId: string } | null> {
  const hash = hashOriginalEmail(email)
  const [row] = await tx
    .select({ id: dataErasureRequests.id })
    .from(dataErasureRequests)
    .where(
      and(
        eq(dataErasureRequests.orgId, orgId),
        eq(dataErasureRequests.originalEmailHash, hash),
        inArray(dataErasureRequests.status, [...BLOCKING_STATUSES])
      )
    )
    .limit(1)
  return row ? { requestId: row.id } : null
}

/**
 * D6/AC-17B: `POST /register` is not reliably org-scoped (self-service signup creates a brand
 * new org; there is no RLS org context yet at this point in the flow), so — like
 * `findRecoveryTokenByHash` in `modules/auth/recovery-lookup.ts` — this is a legitimate read-only
 * lookup via the admin/superuser connection, checked globally across every org's erasure
 * requests. Never used for writes.
 */
export async function findErasedRequestForEmailGlobally(
  email: string
): Promise<{ requestId: string } | null> {
  const hash = hashOriginalEmail(email)
  const [row] = await getAdminDb()
    .select({ id: dataErasureRequests.id })
    .from(dataErasureRequests)
    .where(
      and(
        eq(dataErasureRequests.originalEmailHash, hash),
        inArray(dataErasureRequests.status, [...BLOCKING_STATUSES])
      )
    )
    .limit(1)
  return row ? { requestId: row.id } : null
}
