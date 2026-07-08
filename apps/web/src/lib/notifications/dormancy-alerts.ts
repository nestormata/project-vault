export type SecurityAlertItem = {
  id: string
  alertType: string
  status: string
  payload: Record<string, unknown>
  createdAt: string
}

export type DormancyAlertView = {
  id: string
  machineUserId: string
  machineUserName: string
  keyId: string
  keyName: string
  lastUsedAt: string | null
  projectId: string
  createdAt: string
}

const DORMANT_ALERT_TYPE = 'machine_key.dormant'

/**
 * AC-4 — extends the existing Security Alerts / Notifications inbox surface to render
 * `machine_key.dormant` alerts (7.2's dormancy job writes these into `security_alerts`, listed via
 * `GET /api/v1/org/security-alerts`). Already-dismissed alerts are excluded — the inbox only shows
 * open items, matching every other alert type's convention there. A malformed payload (should not
 * happen given the server's own zod validation, but this is a defensive UI-layer boundary) is
 * dropped rather than crashing the page.
 */
export function toDormancyAlertViews(items: SecurityAlertItem[]): DormancyAlertView[] {
  return items
    .filter((item) => item.alertType === DORMANT_ALERT_TYPE && item.status !== 'dismissed')
    .flatMap((item) => {
      const payload = item.payload
      const keyId = payload['keyId']
      const machineUserId = payload['machineUserId']
      const machineUserName = payload['machineUserName']
      const keyName = payload['keyName']
      const projectId = payload['projectId']
      const lastUsedAt = payload['lastUsedAt']

      if (
        typeof keyId !== 'string' ||
        typeof machineUserId !== 'string' ||
        typeof machineUserName !== 'string' ||
        typeof keyName !== 'string' ||
        typeof projectId !== 'string'
      ) {
        return []
      }

      return [
        {
          id: item.id,
          machineUserId,
          machineUserName,
          keyId,
          keyName,
          lastUsedAt: typeof lastUsedAt === 'string' ? lastUsedAt : null,
          projectId,
          createdAt: item.createdAt,
        },
      ]
    })
}

export type UserDormancyAlertView = {
  id: string
  userId: string
  displayName: string
  orgRole: string
  lastActiveAt: string | null
  createdAt: string
}

const USER_DORMANT_ALERT_TYPE = 'user.dormant'

/**
 * Story 8.7 AC group H — sibling of toDormancyAlertViews() for the `user.dormant` alert type
 * (Story 8.3's dormant-user detection worker), reading `userDormantPayloadSchema`'s fields
 * (`userId`, `displayName`, `orgRole`, `lastActiveAt`). Same filter/map shape: already-dismissed
 * alerts are excluded, and a malformed payload is dropped rather than crashing the page.
 */
export function toUserDormancyAlertViews(items: SecurityAlertItem[]): UserDormancyAlertView[] {
  return items
    .filter((item) => item.alertType === USER_DORMANT_ALERT_TYPE && item.status !== 'dismissed')
    .flatMap((item) => {
      const payload = item.payload
      const userId = payload['userId']
      const displayName = payload['displayName']
      const orgRole = payload['orgRole']
      const lastActiveAt = payload['lastActiveAt']

      if (
        typeof userId !== 'string' ||
        typeof displayName !== 'string' ||
        typeof orgRole !== 'string'
      ) {
        return []
      }

      return [
        {
          id: item.id,
          userId,
          displayName,
          orgRole,
          lastActiveAt: typeof lastActiveAt === 'string' ? lastActiveAt : null,
          createdAt: item.createdAt,
        },
      ]
    })
}
