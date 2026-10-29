import { ApiClientError } from '$lib/api/client.js'

/** One URL per line; blank lines are dropped. */
export function parseUrlLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

export function formatUrlLines(urls: readonly string[]): string {
  return urls.join('\n')
}

/** The first message of an API validation error for one field, if the API named it. */
function fieldDetail(error: ApiClientError, field: string): string | undefined {
  const details = error.details
  if (details === null || typeof details !== 'object') return undefined
  const matches = Object.entries(details as Record<string, unknown>).filter(
    ([key]) => key === field || key.startsWith(`${field}.`)
  )
  const first = matches.map(([, value]) => value).find((value) => Array.isArray(value) && value[0])
  return Array.isArray(first) ? String(first[0]) : undefined
}

export type SettingsFieldErrors = { name?: string; description?: string; urls?: string }

/** Maps an update failure to a page message and per-field messages. */
export function settingsErrorOf(error: unknown): { message: string; fields: SettingsFieldErrors } {
  if (!(error instanceof ApiClientError)) {
    return { message: 'The project could not be saved.', fields: {} }
  }
  if (error.status === 410) {
    return {
      message: 'This project is archived and read-only. Unarchive it before editing.',
      fields: {},
    }
  }
  if (error.status === 403) {
    return {
      message: 'Only the project owner or an organization owner can edit this project.',
      fields: {},
    }
  }
  if (error.status === 422) {
    const name = fieldDetail(error, 'name')
    const description = fieldDetail(error, 'description')
    const urls = fieldDetail(error, 'urls')
    const fields: SettingsFieldErrors = {
      ...(name === undefined ? {} : { name }),
      ...(description === undefined ? {} : { description }),
      ...(urls === undefined ? {} : { urls }),
    }
    return { message: 'Check the highlighted fields.', fields }
  }
  return { message: error.message || 'The project could not be saved.', fields: {} }
}

/** Maps a delete failure (a blocker, a missing authority) to the sentence shown to the user. */
export function deleteErrorOf(error: unknown): string {
  if (!(error instanceof ApiClientError)) return 'The project could not be deleted.'
  const body = error.body as { error?: string; rotationIds?: string[] } | null
  if (body?.error === 'active_rotations') {
    return `This project has ${body.rotationIds?.length ?? 0} in-progress rotation(s). Complete or abandon them before deleting.`
  }
  if (body?.error === 'active_machine_user_keys') {
    return 'This project has machine users with active API keys. Revoke the keys before deleting.'
  }
  if (error.status === 403) {
    return 'Only the project owner or an organization owner can delete this project.'
  }
  return error.message || 'The project could not be deleted.'
}

/** The scheme and the rest of an absolute URL, so a link can be built the way the nav builds its
 * external ones (the router's `resolve()` only knows this app's own routes). */
export function externalUrlParts(url: string): { scheme: string; rest: string } {
  const separator = url.indexOf('://')
  return separator < 0
    ? { scheme: 'https', rest: url }
    : { scheme: url.slice(0, separator), rest: url.slice(separator + 3) }
}
