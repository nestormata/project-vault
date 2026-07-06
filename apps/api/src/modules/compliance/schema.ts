import { z } from 'zod/v4'

export const ErasureRequestParamsSchema = z
  .object({ userId: z.uuid() })
  .meta({ id: 'ErasureRequestParams' })

export const ErasureExecuteParamsSchema = z
  .object({ userId: z.uuid(), requestId: z.uuid() })
  .meta({ id: 'ErasureExecuteParams' })

export const CreateErasureRequestBodySchema = z
  .object({
    reason: z.string().min(1).max(2000),
    requestedBy: z.string().min(1).max(500),
  })
  .strict()
  .meta({ id: 'CreateErasureRequestBody' })

// AC-6: strict boolean, no coercion — z.boolean() already rejects "true"/1/etc, and .strict()
// rejects unexpected extra fields; both fail at schema validation (422), before the handler's
// own `confirm === true` gate ever runs. `confirm` is optional (not just nullable) at the schema
// layer specifically so that OMITTING it entirely reaches the handler's business-logic gate and
// gets the AC-6-mandated 400 confirmation_required, the same outcome as sending `confirm: false`
// — omission is schema-valid, "not true" is a semantic/business decision, not a shape violation.
export const ExecuteErasureBodySchema = z
  .object({ confirm: z.boolean().optional() })
  .strict()
  .meta({ id: 'ExecuteErasureBody' })

const PiiInventoryTableSchema = z.object({
  table: z.string(),
  rowCount: z.number().int().nonnegative(),
  piiFields: z.array(z.string()),
})

export const PiiInventorySchema = z.object({
  tables: z.array(PiiInventoryTableSchema),
})

export const CreateErasureRequestResponseSchema = z
  .object({
    data: z.object({
      requestId: z.uuid(),
      status: z.literal('pending'),
      piiInventory: PiiInventorySchema,
    }),
  })
  .meta({ id: 'CreateErasureRequestResponse' })

export const ExecuteErasureResponseSchema = z
  .object({
    data: z.object({
      requestId: z.uuid(),
      status: z.literal('completed'),
      completedAt: z.iso.datetime(),
      revokedSessionCount: z.number().int().nonnegative(),
      auditEventId: z.uuid().nullable(),
    }),
  })
  .meta({ id: 'ExecuteErasureResponse' })

const PiiRemovedEntrySchema = z.object({
  table: z.string(),
  fields: z.array(z.string()),
  method: z.string(),
})

const PiiRetainedEntrySchema = z.object({
  table: z.string(),
  reason: z.string(),
})

export const ErasureReportResponseSchema = z
  .object({
    data: z.object({
      requestId: z.uuid(),
      executedAt: z.iso.datetime(),
      piiRemoved: z.array(PiiRemovedEntrySchema),
      piiRetained: z.array(PiiRetainedEntrySchema),
      retentionJustification: z.string(),
      auditEventId: z.uuid().nullable(),
    }),
  })
  .meta({ id: 'ErasureReportResponse' })

// Purpose-built error-response schemas — the plain ApiErrorSchema ({code, message, details?}) is
// a non-strict/non-passthrough zod object, so the response serializer strips any field it
// doesn't declare. Every error case below carries fields beyond {code, message}, so each needs
// its own schema unioned alongside ApiErrorSchema at the route (same precedent as
// ActiveRotationsErrorSchema/ActiveMachineUserKeysErrorSchema in packages/shared/src/schemas/api.ts).
export const ErasureAlreadyPendingErrorSchema = z
  .object({
    code: z.literal('erasure_request_already_pending'),
    message: z.string(),
    requestId: z.uuid(),
    piiInventory: PiiInventorySchema,
  })
  .meta({ id: 'ErasureAlreadyPendingError' })

export const ErasureExecutionInProgressErrorSchema = z
  .object({
    code: z.literal('erasure_execution_in_progress'),
    message: z.string(),
    requestId: z.uuid(),
  })
  .meta({ id: 'ErasureExecutionInProgressError' })

export const UserAlreadyErasedErrorSchema = z
  .object({
    code: z.literal('user_already_erased'),
    message: z.string(),
    requestId: z.uuid(),
    completedAt: z.iso.datetime(),
  })
  .meta({ id: 'UserAlreadyErasedError' })

export const UserHasOtherOrgMembershipsErrorSchema = z
  .object({
    code: z.literal('user_has_other_org_memberships'),
    message: z.string(),
    otherOrgCount: z.number().int().nonnegative(),
    remediation: z.string(),
  })
  .meta({ id: 'UserHasOtherOrgMembershipsError' })

export const AlreadyCompletedErrorSchema = z
  .object({
    code: z.literal('already_completed'),
    message: z.string(),
    completedAt: z.iso.datetime(),
  })
  .meta({ id: 'AlreadyCompletedError' })

export const ErasureNotYetCompletedErrorSchema = z
  .object({
    code: z.literal('erasure_not_yet_completed'),
    message: z.string(),
    status: z.string(),
  })
  .meta({ id: 'ErasureNotYetCompletedError' })

export type ErasureRequestParams = z.infer<typeof ErasureRequestParamsSchema>
export type ErasureExecuteParams = z.infer<typeof ErasureExecuteParamsSchema>
export type CreateErasureRequestBody = z.infer<typeof CreateErasureRequestBodySchema>
export type ExecuteErasureBody = z.infer<typeof ExecuteErasureBodySchema>
