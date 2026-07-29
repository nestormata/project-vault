import { z } from 'zod/v4'
import { SUPPORTED_LOCALES } from '@project-vault/shared'

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

// Story 15.2 AC 1 — third setting in this file, mirrors the two dormancy schemas above exactly
// (`.strict()` so an attempted extra field, e.g. a stray `orgId`, is a hard 422 rather than a
// silent no-op — same body-tampering defense as Story 15.1 AC 8's personal-locale endpoint).
// Reuses SUPPORTED_LOCALES from @project-vault/shared, the same source of truth already consumed
// by users.locale's own PATCH /api/v1/users/me/locale endpoint — do not redefine a second enum.
export const OrgDefaultLocaleSettingsBodySchema = z
  .object({ defaultLocale: z.enum(SUPPORTED_LOCALES) })
  .strict()
  .meta({ id: 'OrgDefaultLocaleSettingsBody' })

export const OrgDefaultLocaleSettingsResponseSchema = z
  .object({
    data: z.object({
      orgId: z.uuid(),
      defaultLocale: z.string(),
    }),
  })
  .meta({ id: 'OrgDefaultLocaleSettingsResponse' })

// Story 16.4 AC-1 — fourth setting in this file. Unlike OrgDefaultLocaleSettingsBodySchema's
// fixed z.enum(SUPPORTED_LOCALES), a theme's valid-name set is dynamic/filesystem-defined (no
// fixed enum exists), so this schema only bounds the *shape* (`max(100)`, nullable) — the actual
// live-list-membership check against `getCompiledThemes()` happens in the route handler, mirroring
// `PATCH /themes/selection`'s `ThemeSelectionBodySchema` exactly. `.strict()` for the same
// body-tampering defense as every sibling schema above.
export const OrgDefaultThemeSettingsBodySchema = z
  .object({ themeName: z.string().max(100).nullable() })
  .strict()
  .meta({ id: 'OrgDefaultThemeSettingsBody' })

export const OrgDefaultThemeSettingsResponseSchema = z
  .object({
    data: z.object({
      orgId: z.uuid(),
      defaultThemeName: z.string().nullable(),
    }),
  })
  .meta({ id: 'OrgDefaultThemeSettingsResponse' })
