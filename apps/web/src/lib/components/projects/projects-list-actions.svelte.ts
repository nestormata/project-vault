import { invalidateAll } from '$app/navigation'
import { ApiClientError } from '$lib/api/client.js'
import { archiveProject, unarchiveProject, updateProjectTags } from '$lib/api/projects.js'
import { requestConfirm } from '$lib/state/confirm.svelte.js'
import { parseTagsInput } from '$lib/components/onboarding/onboarding-logic.js'

type NamedProject = { id: string; name: string }
type TaggedProject = { id: string; tags: string[] }

function tagsDetail(error: ApiClientError): string | undefined {
  const details =
    error.details && typeof error.details === 'object'
      ? (error.details as Record<string, string[]>)
      : null
  return details?.tags?.[0] ?? error.message
}

// AC-P4: Zod 422s use a generic top-level `message: 'Request validation failed'` — the
// actionable constraint text lives in `details.tags[]`. Prefer that, and map the common
// max(20)/max(50) cases to the story's user-facing copy.
export function projectTagsErrorMessage(error: unknown): string {
  if (!(error instanceof ApiClientError)) return 'Failed to save tags.'
  const detail = tagsDetail(error)
  if (!detail || detail === 'Request validation failed') {
    return 'Failed to save tags.'
  }
  if (/array|20/i.test(detail) && /too (big|large)|at most|maximum|max/i.test(detail)) {
    return 'A project may have at most 20 tags.'
  }
  if (/string|50|character/i.test(detail) && /too (big|large)|at most|maximum|max/i.test(detail)) {
    return 'Each tag may be at most 50 characters.'
  }
  return detail
}

function archiveErrorMessage(error: unknown): string {
  if (error instanceof ApiClientError && error.code === 'active_rotations') {
    const rotationIds = (error.body as { rotationIds?: string[] } | null)?.rotationIds ?? []
    return `This project has ${rotationIds.length} in-progress rotation(s). Complete or abandon them before archiving.`
  }
  return error instanceof ApiClientError
    ? (error.message ?? 'Failed to archive project.')
    : 'Failed to archive project.'
}

/**
 * Story 69.11: the one owner of the projects list's shared state (which project is busy, the tag
 * inputs and their errors), created by `ProjectsListContent` and handed to the results region and
 * its cards. `setError` writes the page-level error banner the route owns.
 */
export class ProjectsListActions {
  busyProjectId = $state<string | null>(null)
  tagInputs = $state<Record<string, string>>({})
  tagErrors = $state<Record<string, string | null>>({})
  savingTagsProjectId = $state<string | null>(null)
  readonly #setError: (message: string | null) => void

  constructor(setError: (message: string | null) => void) {
    this.#setError = setError
  }

  tagInputValue(project: TaggedProject): string {
    return this.tagInputs[project.id] ?? project.tags.join(', ')
  }

  setTagInput(project: TaggedProject, value: string): void {
    this.tagInputs = { ...this.tagInputs, [project.id]: value }
  }

  async onArchive(project: NamedProject): Promise<void> {
    if (this.busyProjectId) return
    const confirmed = await requestConfirm({
      title: 'Archive project?',
      message:
        `Archive "${project.name}"? Secrets and history are preserved; the project is hidden ` +
        'from active views. You can unarchive it later.',
      confirmLabel: 'Archive',
    })
    if (!confirmed) return
    this.busyProjectId = project.id
    this.#setError(null)
    try {
      await archiveProject(fetch, project.id)
    } catch (error) {
      this.#setError(archiveErrorMessage(error))
      this.busyProjectId = null
      return
    }
    // The archive itself already succeeded above — a refresh failure here is not an archive
    // failure, so it must not surface the "Failed to archive project" error message.
    try {
      await invalidateAll()
    } finally {
      this.busyProjectId = null
    }
  }

  async onUnarchive(project: NamedProject): Promise<void> {
    if (this.busyProjectId) return
    this.busyProjectId = project.id
    this.#setError(null)
    try {
      await unarchiveProject(fetch, project.id)
    } catch (error) {
      this.#setError(
        error instanceof ApiClientError
          ? (error.message ?? 'Failed to unarchive project.')
          : 'Failed to unarchive project.'
      )
      this.busyProjectId = null
      return
    }
    try {
      await invalidateAll()
    } finally {
      this.busyProjectId = null
    }
  }

  async onSaveTags(project: TaggedProject): Promise<void> {
    if (this.savingTagsProjectId) return
    this.savingTagsProjectId = project.id
    this.tagErrors = { ...this.tagErrors, [project.id]: null }
    const nextTags = parseTagsInput(this.tagInputValue(project))
    try {
      await updateProjectTags(fetch, project.id, nextTags)
    } catch (error) {
      this.tagErrors = { ...this.tagErrors, [project.id]: projectTagsErrorMessage(error) }
      this.savingTagsProjectId = null
      return
    }
    try {
      await invalidateAll()
    } finally {
      this.savingTagsProjectId = null
    }
  }
}
