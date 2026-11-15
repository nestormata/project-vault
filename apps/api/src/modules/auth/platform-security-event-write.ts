import { getDb, type Tx } from '@project-vault/db'
import { platformSecurityEvents } from '@project-vault/db/schema'
import { currentAuditKeyVersion } from '../audit/key-version.js'
import { computeAuditHmac } from '../audit/write-entry.js'
import { getAuditKey } from '../vault/key-service.js'

export type PlatformSecurityEventWrite = {
  eventType: string
  subjectHash?: string | null
  payload: Record<string, unknown>
  ipAddress?: string | null
  userAgent?: string | null
  logLabel: string
}

export async function writePlatformSecurityEventBestEffort(
  fields: PlatformSecurityEventWrite
): Promise<void> {
  try {
    const hashedSubject = fields.subjectHash ?? null
    const payload = fields.payload
    await getDb().transaction(async (tx) => {
      const keyVersion = await currentAuditKeyVersion(tx as Tx)
      const hmac = computeAuditHmac(
        {
          eventType: fields.eventType,
          subjectHash: hashedSubject,
          emailDomain: null,
          payload,
          keyVersion,
        },
        getAuditKey()
      )
      await (tx as Tx).insert(platformSecurityEvents).values({
        eventType: fields.eventType,
        subjectHash: hashedSubject,
        emailDomain: null,
        payload,
        keyVersion,
        hmac,
        ipAddress: fields.ipAddress ?? null,
        userAgent: fields.userAgent ?? null,
      })
    })
  } catch (error) {
    process.stderr.write(
      `[${fields.logLabel}] ${error instanceof Error ? error.message : String(error)}\n`
    )
  }
}
