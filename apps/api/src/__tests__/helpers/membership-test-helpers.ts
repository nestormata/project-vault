import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { getDb, withOrg } from '@project-vault/db'
import { orgMemberships, projectMemberships, users } from '@project-vault/db/schema'
import type { createApp } from '../../app.js'
import {
  mintOrgSessionCookies,
  registerAndLoginViaApi,
  type CookieJar,
} from './auth-test-helpers.js'

type TestApp = Awaited<ReturnType<typeof createApp>>

/** Shared password used by every membership route integration suite. */
export const MEMBERSHIP_TEST_LOGIN_SECRET = 'correct-horse-battery-staple'

async function enrollMfa(userId: string): Promise<void> {
  await getDb().update(users).set({ mfaEnrolledAt: new Date() }).where(eq(users.id, userId))
}

async function addProjectMember(
  orgId: string,
  projectId: string,
  userId: string,
  role: string
): Promise<void> {
  await withOrg(orgId, (tx) =>
    tx.insert(projectMemberships).values({ orgId, projectId, userId, role })
  )
}

async function projectRoleOf(
  orgId: string,
  projectId: string,
  userId: string
): Promise<string | undefined> {
  const [row] = await withOrg(orgId, (tx) =>
    tx
      .select({ role: projectMemberships.role })
      .from(projectMemberships)
      .where(
        and(eq(projectMemberships.projectId, projectId), eq(projectMemberships.userId, userId))
      )
  )
  return row?.role
}

/**
 * Builds the membership test scaffolding shared by the org user-management and project
 * member-management route suites. The two suites differ only in the email prefix and the
 * registered org-name prefix, so those are injected here; everything else is identical.
 */
export function createMembershipTestHelpers(config: {
  emailPrefix: string
  orgNamePrefix: string
}) {
  const { emailPrefix, orgNamePrefix } = config

  function uniqueEmail(label: string): string {
    return `${emailPrefix}-${label}-${randomUUID()}@example.com`
  }

  async function registerOwner(app: TestApp, label: string) {
    const user = await registerAndLoginViaApi(app, {
      email: uniqueEmail(label),
      password: MEMBERSHIP_TEST_LOGIN_SECRET,
      orgName: `${orgNamePrefix} ${label} ${randomUUID()}`,
    })
    await enrollMfa(user.userId)
    return user
  }

  /** Registers a user in their own org, then grafts them into `orgId` with the given roles. */
  async function addUserToOrg(
    app: TestApp,
    orgId: string,
    label: string,
    opts: { orgRole?: string } = {}
  ): Promise<{ userId: string; email: string; cookies: CookieJar }> {
    const email = uniqueEmail(label)
    const user = await registerAndLoginViaApi(app, {
      email,
      password: MEMBERSHIP_TEST_LOGIN_SECRET,
      orgName: `Foreign ${label} ${randomUUID()}`,
    })
    await enrollMfa(user.userId)
    await withOrg(orgId, (tx) =>
      tx
        .insert(orgMemberships)
        .values({ orgId, userId: user.userId, role: opts.orgRole ?? 'member' })
    )
    // The login cookie above is scoped to the user's *own* org. Re-mint a session bound to the
    // target org so requests made with these cookies authenticate as a member of `orgId`.
    const cookies = await mintOrgSessionCookies(app, user.userId, orgId)
    return { userId: user.userId, email, cookies }
  }

  return {
    uniqueEmail,
    enrollMfa,
    registerOwner,
    addUserToOrg,
    addProjectMember,
    projectRoleOf,
  }
}
