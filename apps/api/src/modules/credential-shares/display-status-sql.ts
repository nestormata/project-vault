import { sql, type SQL } from 'drizzle-orm'
import { credentialShares } from '@project-vault/db/schema'
import type { ShareDisplayStatus } from '@project-vault/shared'

/**
 * Story 72-11 AC2: the SQL twin of `deriveShareDisplayStatus` (packages/shared), so a
 * `displayStatus` filter pages and counts exactly the rows the derived field would label with that
 * status. Precedence (V10): locked > opened > persisted status; an unknown persisted status reads
 * `revoked`.
 */
const opened = sql`(${credentialShares.status} = 'viewed' OR (${credentialShares.status} = 'active' AND ${credentialShares.singleUse} = false AND ${credentialShares.viewCount} > 0))`
const notLocked = sql`${credentialShares.lockedAt} IS NULL`

export function displayStatusPredicate(displayStatus: ShareDisplayStatus): SQL {
  switch (displayStatus) {
    case 'locked':
      return sql`${credentialShares.lockedAt} IS NOT NULL`
    case 'opened':
      return sql`(${notLocked} AND ${opened})`
    case 'active':
      return sql`(${notLocked} AND ${credentialShares.status} = 'active' AND NOT ${opened})`
    case 'expired':
    case 'superseded':
      return sql`(${notLocked} AND ${credentialShares.status} = ${displayStatus})`
    case 'revoked':
      return sql`(${notLocked} AND ${credentialShares.status} NOT IN ('active', 'viewed', 'expired', 'superseded'))`
  }
}
