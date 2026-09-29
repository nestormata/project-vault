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
 * Marks a user MFA-enrolled directly against the DB, bypassing real TOTP enrollment — used by
 * journeys that need an MFA-gated code path exercised (e.g. a login flow) without needing a real
 * TOTP secret to answer a challenge with. Callers must log the user in BEFORE calling this:
 * enrolling first would make that login demand a TOTP challenge this helper cannot answer, since
 * it never generates a real secret. Shared by J20 and J25 (originally duplicated per-file; jscpd
 * flagged the clone).
 */
export async function enrollMfaDirect(userId: string, dbName: string): Promise<void> {
  const dbUrl = superuserDatabaseUrl().replace(/\/[^/]+$/, `/${dbName}`)
  const sql = postgres(dbUrl, { max: 1 })
  try {
    await sql`update users set mfa_enrolled_at = now() where id = ${userId}`
  } finally {
    await sql.end({ timeout: 5 })
  }
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
 * Story 43.7 AC-7: grants or removes platform-operator status for one journey-owned user.
 * Setup-only, on the disposable E2E database's superuser connection: the product has no UI/API
 * path to promote a user (the first-ever registration is the operator, by design), and relying on
 * that slot makes a journey skip whenever another journey registered first (the j15/j23 pattern).
 * Valid mid-session because apps/api's authenticate plugin (`loadIsPlatformOperator`) reads
 * `users.is_platform_operator` from the DB on every request, so no re-login is needed.
 *
 * The schema allows at most ONE operator instance-wide (`idx_users_one_platform_operator`, a
 * unique partial index — the same constraint apps/api's `registerPlatformOperator` test helper
 * handles), so promoting (`value: true`) first demotes the current operator, in one transaction,
 * and returns that user's email (or null). The caller MUST hand it back to this helper once done
 * (e.g. in `afterAll`) so the displaced operator — typically another journey's first-registered
 * user — is restored. Safe only because the suite runs with `workers: 1`. Demoting
 * (`value: false`) only ever touches the named user; only target a user the journey registered.
 */
export async function setPlatformOperatorViaDb(
  email: string,
  value: boolean
): Promise<string | null> {
  const sql = postgres(superuserDatabaseUrl(), { max: 1 })
  try {
    return await sql.begin(async (tx) => {
      let displaced: string | null = null
      if (value) {
        const demoted = await tx<{ email: string }[]>`
          update users set is_platform_operator = false
          where is_platform_operator = true and email <> ${email}
          returning email
        `
        displaced = demoted[0]?.email ?? null
      }
      const updated = await tx`
        update users set is_platform_operator = ${value} where email = ${email}
      `
      if (updated.count !== 1) {
        throw new Error(`setPlatformOperatorViaDb: expected exactly one user for ${email}`)
      }
      return displaced
    })
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
    // One multi-row insert per table (not one round trip per project): the memberships reference
    // the projects, so the project insert runs first inside the same transaction.
    await sql.begin(async (transaction) => {
      await transaction`
        insert into projects ${transaction(
          projects.map((project) => ({
            id: project.id,
            org_id: input.orgId,
            name: project.name,
            slug: project.slug,
            description: null,
            tags: transaction.json([]),
            created_by: input.userId,
            created_at: project.createdAt,
            updated_at: project.createdAt,
          }))
        )}
      `
      await transaction`
        insert into project_memberships ${transaction(
          projects.map((project) => ({
            org_id: input.orgId,
            project_id: project.id,
            user_id: input.userId,
            role: 'owner',
          }))
        )}
      `
    })
  } finally {
    await sql.end({ timeout: 5 })
  }

  return projects.map(({ id, name }) => ({ id, name }))
}

/**
 * J1 AC-J1-2: read-only proof that a refused or collapsed registration wrote nothing — how many
 * `users` rows carry `email` and how many `organizations` rows carry `orgName`. Registration's
 * self-signup response is deliberately identical for a new and an already-registered email (Story
 * 1.20's anti-enumeration contract), so the database is the only place "no user/org was created"
 * can be observed.
 */
export async function countRegistrationRows(input: {
  email: string
  orgName: string
}): Promise<{ users: number; organizations: number }> {
  const sql = postgres(superuserDatabaseUrl(), { max: 1 })
  try {
    const [row] = await sql<{ users: number; organizations: number }[]>`
      select
        (select count(*)::int from users where email = ${input.email}) as users,
        (select count(*)::int from organizations where name = ${input.orgName}) as organizations
    `
    if (!row) throw new Error('countRegistrationRows: query returned no row')
    return row
  } finally {
    await sql.end({ timeout: 5 })
  }
}
