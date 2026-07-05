import { z } from 'zod/v4'

export const MachineTokenResponseSchema = z
  .object({
    data: z.object({
      accessToken: z.string(),
      tokenType: z.literal('Bearer'),
      expiresIn: z.number().int().positive(),
    }),
  })
  .meta({ id: 'MachineTokenResponse' })

export type MachineTokenResponse = z.infer<typeof MachineTokenResponseSchema>
