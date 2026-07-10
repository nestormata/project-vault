import postgres from 'postgres'

// AC-I3/AC-J2-1: `global-setup.ts` needs a superuser DB connection to reset the schema between
// runs, and AC-J2-1 needs a way to read the raw invitation token that `POST /:projectId/
// invitations` deliberately never returns to the API caller (only a hash is persisted — see
// apps/api/src/modules/invitations/routes.ts's `hashInvitationToken`). The token is only ever
// written into `notification_queue.payload.acceptUrl` (the "email" the invitee would receive) —
// reading that row directly is this suite's documented substitute for real email delivery
// infrastructure (AC-J2-1's own "verify the actual shipped mechanism" note).

function dbHostPort(): string {
  return process.env['DB_HOST_PORT'] ?? '5432'
}

export function superuserDatabaseUrl(): string {
  return (
    process.env['E2E_SUPERUSER_DATABASE_URL'] ??
    `postgresql://postgres:password@localhost:${dbHostPort()}/project_vault`
  )
}

export function appDatabaseUrl(): string {
  return (
    process.env['E2E_APP_DATABASE_URL'] ??
    `postgresql://vault_app:dev-only-change-in-prod@localhost:${dbHostPort()}/project_vault`
  )
}

/**
 * Reads the most recently queued invitation notification for the given recipient email and
 * extracts the accept-invitation token from its payload's `acceptUrl`. Connects as the superuser
 * — `notification_queue` is `orgScoped` and RLS-protected, and a plain `vault_app` connection with
 * no `app.current_org_id` session GUC set returns zero rows regardless of what actually matches
 * (discovered while implementing this story), so RLS must be bypassed the same way nightly.yml's
 * own schema-reset step does.
 */
export async function readLatestInvitationAcceptUrl(recipientEmail: string): Promise<string> {
  const sql = postgres(superuserDatabaseUrl(), { max: 1 })
  try {
    const rows = await sql<{ payload: { acceptUrl?: string } }[]>`
      select payload
      from notification_queue
      where recipient_email = ${recipientEmail}
        and template_id = 'project.invitation_created'
      order by created_at desc
      limit 1
    `
    const acceptUrl = rows[0]?.payload?.acceptUrl
    if (!acceptUrl) {
      throw new Error(
        `No queued invitation notification found for ${recipientEmail} — did the invite actually send?`
      )
    }
    return acceptUrl
  } finally {
    await sql.end({ timeout: 5 })
  }
}

export function extractTokenFromAcceptUrl(acceptUrl: string): string {
  const url = new URL(acceptUrl)
  const token = url.searchParams.get('token')
  if (!token) throw new Error(`acceptUrl had no token param: ${acceptUrl}`)
  return token
}
