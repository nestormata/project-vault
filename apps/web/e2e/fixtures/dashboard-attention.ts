import { randomUUID } from 'node:crypto'
import { withSuperuserSql } from './db.js'

// Story 72.12 (J42): the dashboard attention list reads expiring shares and certificates and
// pending invitations. The product creates none of them with an arbitrary expiry (a certificate is
// a typed record, an invitation expires in days, a share is capped), so the journey seeds the rows
// directly on the disposable E2E database's superuser connection. Setup only: every assertion goes
// through the real UI and the real API.

const HOUR_SECONDS = 3600

export async function userIdByEmail(email: string): Promise<string> {
  return withSuperuserSql(async (sql) => {
    const rows = await sql<{ id: string }[]>`select id from users where email = ${email}`
    const id = rows[0]?.id
    if (!id) throw new Error(`No user with email ${email}`)
    return id
  })
}

/** An external share by `sharedBy` that expires `expiresInHours` from now. */
export async function seedShare(input: {
  orgId: string
  credentialId: string
  sharedBy: string
  recipientEmail: string
  expiresInHours: number
}): Promise<void> {
  await withSuperuserSql(async (sql) => {
    await sql`
      insert into credential_shares
        (org_id, credential_id, shared_by, recipient_type, recipient_email, token_hash, expires_at)
      values
        (${input.orgId}, ${input.credentialId}, ${input.sharedBy}, 'external',
         ${input.recipientEmail}, ${randomUUID()},
         now() + make_interval(secs => ${input.expiresInHours * HOUR_SECONDS}))
    `
  })
}

export async function seedCertificate(input: {
  orgId: string
  projectId: string
  domain: string
  expiresInHours: number
}): Promise<void> {
  await withSuperuserSql(async (sql) => {
    await sql`
      insert into cert_records (org_id, project_id, domain, expires_at)
      values (${input.orgId}, ${input.projectId}, ${input.domain},
              now() + make_interval(secs => ${input.expiresInHours * HOUR_SECONDS}))
    `
  })
}

export async function seedInvitation(input: {
  orgId: string
  projectId: string
  invitedBy: string
  email: string
  expiresInHours: number
}): Promise<void> {
  await withSuperuserSql(async (sql) => {
    await sql`
      insert into project_invitations
        (org_id, project_id, email, role_to_assign, token_hash, invited_by, expires_at)
      values
        (${input.orgId}, ${input.projectId}, ${input.email}, 'member', ${randomUUID()},
         ${input.invitedBy},
         now() + make_interval(secs => ${input.expiresInHours * HOUR_SECONDS}))
    `
  })
}
