import { z } from 'zod/v4'

export const OnboardingStatusResponseSchema = z
  .object({
    completed: z.boolean(),
    completedAt: z.iso.datetime().optional(),
  })
  .meta({ id: 'OnboardingStatusResponse' })

export const CompleteOnboardingBodySchema = z
  .object({
    completed: z.literal(true),
  })
  .strict()
  .meta({ id: 'CompleteOnboardingBody' })

export const CompleteOnboardingResponseSchema = z
  .object({
    completed: z.literal(true),
    completedAt: z.iso.datetime(),
  })
  .meta({ id: 'CompleteOnboardingResponse' })

export type CompleteOnboardingBody = z.infer<typeof CompleteOnboardingBodySchema>
