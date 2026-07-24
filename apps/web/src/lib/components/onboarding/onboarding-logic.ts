import { ApiClientError } from '$lib/api/client.js'
import {
  FIELD_KEY_PATTERN,
  MAX_FIELDS_PER_SECRET,
  normalizeFieldKey,
  templateFields,
  type CredentialTemplate,
} from '@project-vault/shared'

export type OrgRole = 'owner' | 'admin' | 'member' | 'viewer'

// Story 13.2 — an editable field row in the create/edit field-set forms.
export type FieldDraft = { key: string; value: string; sensitive: boolean }

/** Builds the editable draft rows for a template selection (empty for `custom`). Switching
 *  templates is a destructive re-population on the client (AC-1) — the caller decides whether to
 *  confirm before discarding edits. */
export function buildTemplateFieldDrafts(template: CredentialTemplate): FieldDraft[] {
  return templateFields(template).map((f) => ({ key: f.key, value: '', sensitive: f.sensitive }))
}

/** Index of the first field whose (normalized) key collides with an earlier field's key, or -1.
 *  A client-side affordance layered on top of — never replacing — the server's authoritative 409. */
export function duplicateFieldKeyIndex(fields: Pick<FieldDraft, 'key'>[]): number {
  const seen = new Set<string>()
  for (let i = 0; i < fields.length; i++) {
    const key = fields[i]?.key ?? ''
    if (!key.trim()) continue
    const norm = normalizeFieldKey(key)
    if (seen.has(norm)) return i
    seen.add(norm)
  }
  return -1
}

export type FieldSetValidation = {
  ok: boolean
  fieldErrors: Record<number, string>
  formError?: string
}

/** Validates a field-set draft before submit: at least one field, non-empty valid keys, no
 *  duplicate keys, within the field cap. Mirrors the shared Zod/service constraints so the user
 *  gets immediate feedback (the server re-validates authoritatively). */
export function validateFieldSet(fields: FieldDraft[]): FieldSetValidation {
  const fieldErrors: Record<number, string> = {}
  if (fields.length === 0) {
    return { ok: false, fieldErrors, formError: 'Add at least one field before saving.' }
  }
  if (fields.length > MAX_FIELDS_PER_SECRET) {
    return {
      ok: false,
      fieldErrors,
      formError: `A secret may have at most ${MAX_FIELDS_PER_SECRET} fields.`,
    }
  }
  fields.forEach((field, index) => {
    const key = field.key.trim()
    if (!key) {
      fieldErrors[index] = 'Field name is required'
    } else if (!FIELD_KEY_PATTERN.test(key)) {
      fieldErrors[index] = 'Only letters, numbers, spaces, and _ . - are allowed'
    }
  })
  const dupIndex = duplicateFieldKeyIndex(fields)
  if (dupIndex >= 0) {
    fieldErrors[dupIndex] = 'Duplicate field name'
  }
  return { ok: Object.keys(fieldErrors).length === 0, fieldErrors }
}

export const CREDENTIAL_CREATOR_ROLES = ['member', 'admin', 'owner'] as const

export function canCreateCredential(orgRole: OrgRole): boolean {
  return (CREDENTIAL_CREATOR_ROLES as readonly string[]).includes(orgRole)
}

export function canCreateProject(orgRole: OrgRole): boolean {
  return canCreateCredential(orgRole)
}

export function parseTagsInput(raw: string): string[] {
  return raw
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean)
}

export function validateCredentialForm(input: { name: string; value: string }) {
  const errors: { name?: string; value?: string } = {}
  if (!input.name.trim()) errors.name = 'Name is required'
  if (!input.value.trim()) errors.value = 'Credential value cannot be empty'
  return errors
}

/** Pulls the conflicting field key out of a field_key_conflict error. Prefers a structured
 *  `details.key`, falling back to the quoted key in the human message. */
function extractConflictKey(error: ApiClientError): string | undefined {
  const details = error.details as { key?: unknown } | undefined
  if (details && typeof details.key === 'string') return details.key
  const match = /"([^"]+)"/.exec(error.message)
  return match?.[1]
}

export type CredentialSubmitError = {
  fieldErrors: { name?: string; value?: string }
  errorMessage: string
  // Story 13.2 AC-3 — the conflicting field key from a 409 field_key_conflict, so the form can
  // attach an inline error to the specific field being renamed/added.
  fieldKeyConflict?: string
}

function mapValidationSubmitError(error: ApiClientError): CredentialSubmitError {
  const details =
    error.details && typeof error.details === 'object'
      ? (error.details as Record<string, string[]>)
      : {}
  return {
    fieldErrors: { name: details.name?.[0], value: details.value?.[0] },
    errorMessage: error.message,
  }
}

function mapApiClientSubmitError(error: ApiClientError): CredentialSubmitError {
  if (error.status === 409 && error.code === 'field_key_conflict') {
    const conflicting = extractConflictKey(error)
    return {
      fieldErrors: {},
      errorMessage: error.message,
      ...(conflicting ? { fieldKeyConflict: conflicting } : {}),
    }
  }
  if (error.status === 422) return mapValidationSubmitError(error)
  if (error.status === 403) {
    return { fieldErrors: {}, errorMessage: 'You do not have permission to create credentials.' }
  }
  return { fieldErrors: {}, errorMessage: error.message }
}

export function mapCredentialSubmitError(error: unknown): CredentialSubmitError {
  if (error instanceof ApiClientError) return mapApiClientSubmitError(error)
  return {
    fieldErrors: {},
    errorMessage: error instanceof Error ? error.message : 'Could not save credential.',
  }
}

export const onboardingCopy = {
  welcomeHeading: 'Welcome to Project Vault',
  projectModel:
    'Everything in Project Vault lives inside a Project. A project is a container for all the secrets, services, and certificates that belong together — like payments-api or mobile-backend. There are no environments; instead, each environment can be its own project, or you can use tags to distinguish them within a project.',
  step1Cta: "Got it — Let's add a credential",
  vaultSealedMessage:
    'The vault is sealed — credentials cannot be saved right now. Ask your administrator to unseal the vault.',
  viewerStep2Message:
    'Credential creation requires Member access. Ask your admin to upgrade your role, or explore the dashboard to see what your team has already secured.',
  viewerNoProjectsMessage:
    "Your admin hasn't created any projects yet. Check back when a project is set up for you, or ask your admin to invite you to an existing project.",
  globalSearchMention: 'Global search across all your projects is coming soon.',
} as const

export const forbiddenOnboardingTerms = [/^environment$/i] as const

export function containsForbiddenStructuralTerm(text: string): boolean {
  return forbiddenOnboardingTerms.some((pattern) => pattern.test(text.trim()))
}
