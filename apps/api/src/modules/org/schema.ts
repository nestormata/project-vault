import { z } from 'zod/v4'

export const OrgUserParamsSchema = z.object({
  userId: z.uuid(),
})

export type OrgUserParams = z.infer<typeof OrgUserParamsSchema>
