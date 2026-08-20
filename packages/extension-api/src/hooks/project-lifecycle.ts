/**
 * Host-called policy hook for project creation. PV owns the transaction, project rows,
 * memberships, tenant context, and audit write. An extension may only answer whether the
 * already-authorized PV request is allowed to create one more project.
 */
export type ProjectCreatePolicyContext = {
  organizationId: string
  actorUserId: string
  projectName: string
  currentProjectCount: number
  creationRequestId: string
}

export type ProjectCreateDecision =
  { permitted: true } | { permitted: false; reasonCode: string; message?: string }

export type ProjectCreatePolicy = {
  onBeforeCreateProject(context: ProjectCreatePolicyContext): Promise<ProjectCreateDecision>
}
