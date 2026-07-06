import { ApiClientError } from '$lib/api/client.js'

export type MonitoringSubmitErrorResult = {
  fieldErrors: Record<string, string>
  errorMessage: string
}

function firstFieldMessage(messages: unknown): string | null {
  const [first] = Array.isArray(messages) ? messages : []
  return typeof first === 'string' ? first : null
}

function extractFieldErrors(details: unknown): Record<string, string> {
  const record = details && typeof details === 'object' ? (details as Record<string, unknown>) : {}
  const entries = Object.entries(record)
    .map(([field, messages]) => [field, firstFieldMessage(messages)] as const)
    .filter((entry): entry is [string, string] => entry[1] !== null)
  return Object.fromEntries(entries)
}

function mapApiClientError(
  error: ApiClientError,
  forbiddenMessage: string
): MonitoringSubmitErrorResult {
  if (error.status === 422) {
    return { fieldErrors: extractFieldErrors(error.details), errorMessage: error.message }
  }
  if (error.status === 403) {
    return { fieldErrors: {}, errorMessage: forbiddenMessage }
  }
  if (error.status === 410) {
    return { fieldErrors: {}, errorMessage: 'This project is archived and cannot be modified.' }
  }
  return { fieldErrors: {}, errorMessage: error.message }
}

// Shared error mapper for services/certificates/domains/service-endpoints create+edit forms
// (Story 6.4, mirrors credentials/new's mapCredentialSubmitError-style logic per Background's API
// error shape note). A raw ApiClientError.message must never reach the DOM unformatted for cases
// this mapper doesn't special-case (it may include a Zod field-path string) — every branch below
// returns a message meant for end users, or the server's own already-user-facing message for the
// exact/verbatim-surface cases the story calls out (e.g. service_endpoint_limit_reached,
// url_not_allowed).
export function mapMonitoringSubmitError(
  error: unknown,
  forbiddenMessage: string
): MonitoringSubmitErrorResult {
  if (error instanceof ApiClientError) {
    return mapApiClientError(error, forbiddenMessage)
  }
  return {
    fieldErrors: {},
    errorMessage: error instanceof Error ? error.message : 'Could not save changes.',
  }
}
