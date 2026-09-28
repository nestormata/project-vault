import { z } from 'zod/v4'
import { FIELD_KEY_MAX_LENGTH, FIELD_KEY_PATTERN, FieldSchema } from '@project-vault/shared'

export const MachineCredentialParamsSchema = z
  .object({ projectId: z.uuid(), name: z.string().min(1) })
  .meta({ id: 'MachineCredentialParams' })

// Story 13.3 — mirrors CredentialValueQuerySchema (human route) for the machine reveal route's
// own `?field=` support (architecture.md's explicit statement this route gains it too).
export const MachineCredentialValueQuerySchema = z
  .object({
    field: z.string().trim().min(1).max(FIELD_KEY_MAX_LENGTH).regex(FIELD_KEY_PATTERN).optional(),
  })
  .strict()
  .meta({ id: 'MachineCredentialValueQuery' })
export type MachineCredentialValueQuery = z.infer<typeof MachineCredentialValueQuerySchema>

// Story 43.4 AC-3 — the optional, CLIENT-ASSERTED invocation context `pvault get`/`pvault run`
// send as `x-vault-invocation` / `x-vault-target-command` headers (headers, not query params: the
// query schema above is `.strict()` and query strings land in access logs). These values end up in
// an HMAC-chained, tamper-evident audit payload, so they are validated before being written — but
// an invalid value never fails the reveal (see client-invocation-context.ts).
//
// A future Epic 50 broker label (e.g. `mcp`) is a one-value extension of this allowlist AND of
// packages/agent's invocation-context.ts — deliberately not added until a consumer exists.
// Story 43.5 AC-8 — `write-env` = revealed and persisted to a local file.
export const ClientInvocationHeaderSchema = z.enum(['get', 'run', 'write-env'])

const TARGET_COMMAND_ENCODED_PATTERN = /^[A-Za-z0-9%._+~-]{1,128}$/

function safeDecodeURIComponent(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch {
    // Malformed escapes (e.g. `%E0%A4%A`) throw URIError — treated as "rejected", never a 500.
    return null
  }
}

/**
 * Story 43.13 AC-4.2 — the terminal-unsafe set U: C0 (U+0000-U+001F), DEL and C1 (U+007F-U+009F),
 * every Unicode format character (\p{Cf}: bidi controls and marks, zero-width characters, word
 * joiner, BOM, soft hyphen, ...), the line/paragraph separators U+2028/U+2029 and the whole tag
 * block U+E0000-U+E007F. None of it may reach an audit UI or a log forwarder: no newlines, no ANSI
 * escapes, and nothing that visually reorders or hides part of a command name.
 *
 * The source of truth for U is packages/agent/src/terminal-unsafe-characters.ts; the API cannot
 * import the agent, so the set is duplicated here on purpose and tied to it by the parity cases in
 * client-invocation-context.test.ts. The header is client-asserted, so this server check (not the
 * agent's client-side stripping) is the authoritative control.
 */
const FORMAT_OR_LINE_SEPARATOR = /[\p{Cf}\u2028\u2029]/u
const TAG_BLOCK_FIRST = 0xe0000
const TAG_BLOCK_LAST = 0xe007f

function isUnsafeCodePoint(codePoint: number): boolean {
  return (
    codePoint < 0x20 ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    (codePoint >= TAG_BLOCK_FIRST && codePoint <= TAG_BLOCK_LAST)
  )
}

function containsUnsafeCharacter(value: string): boolean {
  for (const char of value) {
    if (isUnsafeCodePoint(char.codePointAt(0) ?? 0) || FORMAT_OR_LINE_SEPARATOR.test(char)) {
      return true
    }
  }
  return false
}

export const ClientTargetCommandHeaderSchema = z
  .string()
  .regex(TARGET_COMMAND_ENCODED_PATTERN)
  .transform((value) => safeDecodeURIComponent(value))
  .refine((decoded): decoded is string => decoded !== null && !containsUnsafeCharacter(decoded))

const machineCredentialValueDataBase = {
  name: z.string(),
  versionNumber: z.number().int().positive(),
  // AC-6: `cacheable` is present on EVERY successful response, not just non-cacheable ones — the
  // offline agent's non-cacheable-exclusion logic (AC-14) depends on this being part of the
  // baseline schema.
  cacheable: z.boolean(),
}

// Story 13.3 — discriminated response, mirroring the human `/value` route: legacy/single-
// default-field secrets keep the existing bare `{ value }` shape; a genuinely multi-field secret
// returns the structured `{ fields: [...] }` shape instead.
export const MachineCredentialValueResponseSchema = z
  .object({
    data: z.union([
      z.object({ ...machineCredentialValueDataBase, value: z.string() }),
      z.object({ ...machineCredentialValueDataBase, fields: z.array(FieldSchema) }),
    ]),
  })
  .meta({ id: 'MachineCredentialValueResponse' })

export const AmbiguousCredentialNameErrorSchema = z
  .object({
    code: z.literal('ambiguous_credential_name'),
    message: z.string(),
    matchCount: z.number().int().min(2),
  })
  .meta({ id: 'AmbiguousCredentialNameError' })

// Story 7.2 D13/AC-15 — the offline agent's fallback-mode activation beacon. `activatedAt` is the
// ISO-8601 timestamp fallback mode began (not the report time); `threshold` is the effective
// `VAULT_FALLBACK_THRESHOLD` that triggered it. `projectId` is not part of the body — it is
// already carried in the machine JWT's `scope` claim that authenticates the call.
export const CacheActivatedBodySchema = z
  .object({
    activatedAt: z.iso.datetime(),
    threshold: z.number().int().positive(),
  })
  .meta({ id: 'CacheActivatedBody' })

export const CacheActivatedResponseSchema = z
  .object({
    data: z.object({ recorded: z.literal(true) }),
  })
  .meta({ id: 'CacheActivatedResponse' })
