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

// Story 8.3 D5/AC-12 — mirrors MachineKeySettingsBodySchema exactly (same allowed enum).
export const UserDormancySettingsBodySchema = z
  .object({
    userDormancyThresholdDays: z.union([
      z.literal(30),
      z.literal(60),
      z.literal(90),
      z.literal(180),
    ]),
  })
  .strict()
  .meta({ id: 'UserDormancySettingsBody' })

export const UserDormancySettingsResponseSchema = z
  .object({
    data: z.object({
      orgId: z.uuid(),
      userDormancyThresholdDays: z.number().int(),
    }),
  })
  .meta({ id: 'UserDormancySettingsResponse' })
