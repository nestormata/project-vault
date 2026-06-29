import { withOrg } from '../index.js'
import { credentials, projects } from '../schema/index.js'

export async function createCredentialTestProject(
  orgId: string,
  userId: string,
  slug: string
): Promise<string> {
  const [project] = await withOrg(orgId, (tx) =>
    tx
      .insert(projects)
      .values({ orgId, name: slug, slug, createdBy: userId })
      .returning({ id: projects.id })
  )
  if (!project) throw new Error('expected test project to be inserted')
  return project.id
}

export async function insertTestCredential(
  orgId: string,
  projectId: string,
  userId: string,
  name: string
): Promise<string> {
  const [credential] = await withOrg(orgId, (tx) =>
    tx
      .insert(credentials)
      .values({ orgId, projectId, name, createdBy: userId })
      .returning({ id: credentials.id })
  )
  if (!credential) throw new Error('expected test credential to be inserted')
  return credential.id
}

export async function withTwoTestOrgs<T>(
  run: (orgs: { orgAId: string; orgBId: string }) => Promise<T>
): Promise<T> {
  const { withTestOrg } = await import('../test-helpers.js')
  return withTestOrg(async ({ orgId: orgAId }) =>
    withTestOrg(async ({ orgId: orgBId }) => run({ orgAId, orgBId }))
  )
}
