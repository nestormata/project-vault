import postgres from 'postgres'
import { randomUUID } from 'node:crypto'

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

export async function setOrganizationRoleViaDb(
  orgId: string,
  email: string,
  role: 'owner' | 'admin' | 'member' | 'viewer'
): Promise<void> {
  const sql = postgres(superuserDatabaseUrl(), { max: 1 })
  try {
    await sql`
      update org_memberships
      set role = ${role}
      where org_id = ${orgId}
        and user_id = (select id from users where email = ${email})
    `
  } finally {
    await sql.end({ timeout: 5 })
  }
}

/**
 * Creates a large deterministic project set for pagination journeys without spending the real
 * project-creation rate limit. The browser still performs the authenticated GET/list/dashboard
 * journey; this helper is setup-only and inserts the same project and membership records the API
 * would create, using the disposable E2E database's superuser connection.
 */
export async function createProjectsViaDb(input: {
  orgId: string
  userId: string
  count: number
  namePrefix: string
}): Promise<Array<{ id: string; name: string }>> {
  const sql = postgres(superuserDatabaseUrl(), { max: 1 })
  const projects = Array.from({ length: input.count }, (_, index) => ({
    id: randomUUID(),
    name: `${input.namePrefix} ${String(index + 1).padStart(3, '0')}`,
    slug: `${input.namePrefix.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${index + 1}`,
    // The endpoint sorts newest first, so project 001 is guaranteed to be on page 2.
    createdAt: new Date(Date.now() - (input.count - index) * 1_000),
  }))

  try {
    await sql.begin(async (transaction) => {
      for (const project of projects) {
        await transaction`
          insert into projects (id, org_id, name, slug, description, tags, created_by, created_at, updated_at)
          values (${project.id}, ${input.orgId}, ${project.name}, ${project.slug}, null, '[]'::jsonb, ${input.userId}, ${project.createdAt}, ${project.createdAt})
        `
        await transaction`
          insert into project_memberships (org_id, project_id, user_id, role)
          values (${input.orgId}, ${project.id}, ${input.userId}, 'owner')
        `
      }
    })
  } finally {
    await sql.end({ timeout: 5 })
  }

  return projects.map(({ id, name }) => ({ id, name }))
}
