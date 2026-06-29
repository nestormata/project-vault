import { z } from 'zod/v4'

export const ImportActionSchema = z
  .enum(['new_version', 'skip', 'create_new'])
  .meta({ id: 'ImportAction' })

export const ParsedImportItemSchema = z
  .object({
    name: z.string(),
    value: z.literal('[REDACTED]'),
    conflictsWith: z.uuid().nullable(),
    conflictName: z.string().nullable(),
    suggestedAction: ImportActionSchema,
  })
  .meta({ id: 'ParsedImportItem' })

export const ParseWarningSchema = z
  .object({
    line: z.number().int(),
    reason: z.enum(['no_equals_sign', 'empty_value', 'invalid_key', 'duplicate_key']),
    raw: z.string(),
  })
  .meta({ id: 'ParseWarning' })

export const ImportPreviewResponseSchema = z
  .object({
    data: z.object({
      importId: z.uuid(),
      expiresAt: z.iso.datetime(),
      itemCount: z.number().int(),
      parsed: z.array(ParsedImportItemSchema),
      warnings: z.array(ParseWarningSchema),
    }),
  })
  .meta({ id: 'ImportPreviewResponse' })

export const ImportResultItemSchema = z
  .object({
    name: z.string(),
    action: ImportActionSchema,
    credentialId: z.uuid().nullable(),
  })
  .meta({ id: 'ImportResultItem' })

export const ImportConfirmResponseSchema = z
  .object({
    data: z.object({
      imported: z.number().int(),
      newVersions: z.number().int(),
      skipped: z.number().int(),
      results: z.array(ImportResultItemSchema),
    }),
  })
  .meta({ id: 'ImportConfirmResponse' })

export type ImportAction = z.infer<typeof ImportActionSchema>
export type ParsedImportItem = z.infer<typeof ParsedImportItemSchema>
export type ImportResultItem = z.infer<typeof ImportResultItemSchema>
