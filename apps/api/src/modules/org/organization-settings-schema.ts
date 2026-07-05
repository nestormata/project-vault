import { z } from 'zod/v4'

export const OrgSettingsParamsSchema = z.object({ orgId: z.uuid() })

// D8/FR110 — epics.md's exact enum (AC-E7b).
export const MachineKeySettingsBodySchema = z
  .object({
    machineKeyDormancyThresholdDays: z.union([
      z.literal(30),
      z.literal(60),
      z.literal(90),
      z.literal(180),
    ]),
  })
  .strict()
  .meta({ id: 'MachineKeySettingsBody' })

export const MachineKeySettingsResponseSchema = z
  .object({
    data: z.object({
      orgId: z.uuid(),
      machineKeyDormancyThresholdDays: z.number().int(),
    }),
  })
  .meta({ id: 'MachineKeySettingsResponse' })
