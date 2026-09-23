import type { IncomingHttpHeaders } from 'node:http'
import {
  ClientInvocationHeaderSchema,
  ClientTargetCommandHeaderSchema,
} from './machine-credential-schema.js'

export const INVOCATION_HEADER = 'x-vault-invocation'
export const TARGET_COMMAND_HEADER = 'x-vault-target-command'

/**
 * Story 43.4 AC-3 — the audit-payload keys derived from the optional invocation-context headers.
 *
 * Named `client*` on purpose: `machineUserId`/`keyId` are server-verified, but these two are
 * CLIENT-ASSERTED — a holder of the machine key can claim `ls` while running anything. An auditor
 * must never read `clientTargetCommand` as proof of what ran.
 */
export type ClientInvocationAuditFields = {
  clientInvocation?: 'get' | 'run'
  clientTargetCommand?: string
  clientInvocationContextRejected?: true
}

/**
 * Validates each header independently. Absent headers ⇒ `{}` (no new payload keys, so existing
 * `vault-action`/older-CLI payloads stay byte-identical). An invalid, repeated, or oversized value
 * is dropped and `clientInvocationContextRejected: true` is recorded instead — the header is
 * advisory, so it can never fail the reveal itself.
 */
export function parseClientInvocationContext(
  headers: IncomingHttpHeaders
): ClientInvocationAuditFields {
  const fields: ClientInvocationAuditFields = {}

  const rawInvocation = headers[INVOCATION_HEADER]
  if (rawInvocation !== undefined) {
    const parsed = ClientInvocationHeaderSchema.safeParse(rawInvocation)
    if (parsed.success) fields.clientInvocation = parsed.data
    else fields.clientInvocationContextRejected = true
  }

  const rawTargetCommand = headers[TARGET_COMMAND_HEADER]
  if (rawTargetCommand !== undefined) {
    const parsed = ClientTargetCommandHeaderSchema.safeParse(rawTargetCommand)
    if (parsed.success) fields.clientTargetCommand = parsed.data
    else fields.clientInvocationContextRejected = true
  }

  return fields
}
