import { z } from 'zod/v4'

export const InvitationRoleSchema = z.enum(['admin', 'member', 'viewer'])

export const CreateInvitationBodySchema = z
  .object({
    email: z.email(),
    role: InvitationRoleSchema,
  })
  .strict()
  .meta({ id: 'CreateInvitationBody' })

export const ProjectInvitationParamsSchema = z
  .object({ projectId: z.uuid() })
  .meta({ id: 'ProjectInvitationParams' })

export const RevokeInvitationParamsSchema = z
  .object({ projectId: z.uuid(), id: z.uuid() })
  .meta({ id: 'RevokeInvitationParams' })

export const InvitationTokenParamsSchema = z
  .object({ token: z.string().min(1).max(512) })
  .meta({ id: 'InvitationTokenParams' })

export const CreateInvitationResponseSchema = z
  .object({
    data: z.object({
      id: z.uuid(),
      projectId: z.uuid(),
      email: z.email(),
      roleToAssign: InvitationRoleSchema,
      invitedBy: z.uuid(),
      expiresAt: z.iso.datetime(),
    }),
  })
  .meta({ id: 'CreateInvitationResponse' })

export const InvitationListResponseSchema = z
  .object({
    data: z.array(
      z.object({
        id: z.uuid(),
        email: z.email(),
        roleToAssign: InvitationRoleSchema,
        invitedBy: z.uuid(),
        expiresAt: z.iso.datetime(),
      })
    ),
  })
  .meta({ id: 'InvitationListResponse' })

export const InvitationPeekResponseSchema = z
  .object({
    data: z.object({
      email: z.email(),
      projectName: z.string(),
      role: InvitationRoleSchema,
      accountExists: z.boolean(),
    }),
  })
  .meta({ id: 'InvitationPeekResponse' })

export const InvitationAcceptResponseSchema = z
  .object({
    data: z.object({
      projectId: z.uuid(),
      projectName: z.string(),
      role: InvitationRoleSchema,
    }),
  })
  .meta({ id: 'InvitationAcceptResponse' })

export type InvitationRole = z.infer<typeof InvitationRoleSchema>
export type CreateInvitationBody = z.infer<typeof CreateInvitationBodySchema>
export type ProjectInvitationParams = z.infer<typeof ProjectInvitationParamsSchema>
export type RevokeInvitationParams = z.infer<typeof RevokeInvitationParamsSchema>
export type InvitationTokenParams = z.infer<typeof InvitationTokenParamsSchema>
