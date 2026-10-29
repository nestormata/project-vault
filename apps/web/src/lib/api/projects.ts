import {
  trimHyphens,
  type DeletedProject,
  type ProjectArchiveState,
  type ProjectDashboard,
  type ProjectDetail,
  type ProjectOverview,
  type ProjectSummary,
} from '@project-vault/shared'
import { ApiClientError, apiFetch } from './client.js'

export type CreateProjectRequest = {
  name: string
  slug: string
  description?: string | null
}

export type UpdateProjectRequest = {
  name?: string
  description?: string | null
  /** Story 72-9: replaces the whole list; an empty array clears it. */
  urls?: string[]
}

export type UpdateProjectResponse = {
  id: string
  name: string
  slug: string
  description: string | null
  urls: string[]
  updatedAt: string
}

/** Story 72-9: the result of a soft delete. */
export type DeleteProjectResponse = {
  id: string
  name: string
  slug: string
  deletedAt: string
  purgeAfter: string
  revokedShareCount: number
}

export type ProjectListPage = {
  items: ProjectSummary[]
  total: number
  page: number
  limit: number
  hasNext: boolean
}

type ListProjectsOptions = {
  includeArchived?: boolean
  page?: number
  limit?: number
}

const PROJECT_LIST_PAGE_SIZE = 100
const MAX_PROJECT_LIST_PAGES = 1_000

function jsonMutation(method: 'POST' | 'PATCH', body: unknown): RequestInit {
  return { method, body: JSON.stringify(body) }
}

export function suggestProjectSlug(name: string): string {
  const normalized = name
    .trim()
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^a-z0-9]+/g, '-')
  const slug = trimHyphens(trimHyphens(normalized).slice(0, 50))
  return slug.length >= 3 ? slug : 'project'
}

export function createProject(fetchFn: typeof fetch, body: CreateProjectRequest) {
  return apiFetch<ProjectDetail>(fetchFn, '/api/v1/projects', jsonMutation('POST', body))
}

export function listProjects(fetchFn: typeof fetch, options: ListProjectsOptions = {}) {
  const params = new URLSearchParams()
  if (options.includeArchived) params.set('includeArchived', 'true')
  if (options.page !== undefined) params.set('page', String(options.page))
  if (options.limit !== undefined) params.set('limit', String(options.limit))
  const query = params.toString() ? `?${params.toString()}` : ''
  return apiFetch<ProjectListPage>(fetchFn, `/api/v1/projects${query}`)
}

function invalidProjectPagination(reason: string): Error {
  return new Error(`Invalid project pagination response: ${reason}`)
}

function validateProjectPageMetadata(response: ProjectListPage, page: number): void {
  const valid =
    Array.isArray(response.items) &&
    Number.isInteger(response.total) &&
    response.total >= 0 &&
    response.page === page &&
    response.limit === PROJECT_LIST_PAGE_SIZE &&
    typeof response.hasNext === 'boolean'
  if (!valid) throw invalidProjectPagination(`page ${page} has inconsistent metadata`)
}

function appendProjectItems(
  items: ProjectSummary[],
  seenProjectIds: Set<string>,
  pageItems: ProjectSummary[],
  page: number
): void {
  for (const item of pageItems) {
    if (typeof item?.id !== 'string' || seenProjectIds.has(item.id)) {
      throw invalidProjectPagination(`page ${page} contains a duplicate or invalid project ID`)
    }
    seenProjectIds.add(item.id)
    items.push(item)
  }
}

function validatePageProgress(
  response: ProjectListPage,
  itemsLoaded: number,
  total: number,
  page: number
): void {
  if (itemsLoaded > total) {
    throw invalidProjectPagination(`page ${page} contains more items than total`)
  }
  if (response.hasNext && response.items.length === 0) {
    throw invalidProjectPagination(`page ${page} made no progress`)
  }
  if (response.hasNext && itemsLoaded >= total) {
    throw invalidProjectPagination(`page ${page} claims another page after total is complete`)
  }
}

export function listAllProjects(fetchFn: typeof fetch): Promise<ProjectListPage> {
  return loadProjectPages(fetchFn, { items: [], seenProjectIds: new Set<string>(), total: null }, 1)
}

type ProjectPagingState = {
  items: ProjectSummary[]
  seenProjectIds: Set<string>
  total: number | null
}

/** Loads page `page`, then (each page waiting on the previous one) the next, until the last. */
async function loadProjectPages(
  fetchFn: typeof fetch,
  state: ProjectPagingState,
  page: number
): Promise<ProjectListPage> {
  if (page > MAX_PROJECT_LIST_PAGES) {
    throw invalidProjectPagination(`exceeded the ${MAX_PROJECT_LIST_PAGES}-page safety bound`)
  }
  const response = await listProjects(fetchFn, { page, limit: PROJECT_LIST_PAGE_SIZE })
  validateProjectPageMetadata(response, page)

  state.total ??= response.total
  const total = state.total
  if (response.total !== total) {
    throw invalidProjectPagination(`page ${page} changed total`)
  }

  const { items } = state
  appendProjectItems(items, state.seenProjectIds, response.items, page)
  validatePageProgress(response, items.length, total, page)
  if (!response.hasNext) {
    if (items.length !== total) {
      throw invalidProjectPagination(`page ${page} ended before total items were loaded`)
    }
    return { items, total, page: 1, limit: PROJECT_LIST_PAGE_SIZE, hasNext: false }
  }

  return loadProjectPages(fetchFn, state, page + 1)
}

export function archiveProject(
  fetchFn: typeof fetch,
  projectId: string
): Promise<ProjectArchiveState> {
  return apiFetch<ProjectArchiveState>(fetchFn, `/api/v1/projects/${projectId}/archive`, {
    method: 'POST',
  })
}

export function unarchiveProject(
  fetchFn: typeof fetch,
  projectId: string
): Promise<ProjectArchiveState> {
  return apiFetch<ProjectArchiveState>(fetchFn, `/api/v1/projects/${projectId}/unarchive`, {
    method: 'POST',
  })
}

/** Story 72-9: soft delete (project owner or org owner, MFA). Purged after the grace period. */
export function deleteProject(
  fetchFn: typeof fetch,
  projectId: string
): Promise<DeleteProjectResponse> {
  return apiFetch<DeleteProjectResponse>(fetchFn, `/api/v1/projects/${projectId}`, {
    method: 'DELETE',
  })
}

/** Story 72-9: restore a soft-deleted project; it comes back archived. */
export function restoreProject(
  fetchFn: typeof fetch,
  projectId: string
): Promise<ProjectArchiveState> {
  return apiFetch<ProjectArchiveState>(fetchFn, `/api/v1/projects/${projectId}/restore`, {
    method: 'POST',
  })
}

/** Story 72-9: the deleted projects the caller may restore. */
export async function listDeletedProjects(fetchFn: typeof fetch): Promise<DeletedProject[]> {
  const result = await apiFetch<{ items: DeletedProject[] }>(fetchFn, '/api/v1/projects/deleted')
  return result.items
}

export function getProjectDashboard(fetchFn: typeof fetch, projectId: string) {
  return apiFetch<ProjectDashboard>(fetchFn, `/api/v1/projects/${projectId}/dashboard`)
}

// 12-1 AC-1/AC-2: project overview detail (name/description/tags/ownership/archived state +
// member count) for the new /projects/:id page.
export function getProject(fetchFn: typeof fetch, projectId: string): Promise<ProjectOverview> {
  return apiFetch<ProjectOverview>(fetchFn, `/api/v1/projects/${projectId}`)
}

/** Story 72-9: the project, or null when the API answers 404 (missing, foreign or deleted). */
export async function getProjectOrNull(
  fetchFn: typeof fetch,
  projectId: string
): Promise<ProjectOverview | null> {
  try {
    return await getProject(fetchFn, projectId)
  } catch (error) {
    if (error instanceof ApiClientError && error.status === 404) return null
    throw error
  }
}

export function updateProject(
  fetchFn: typeof fetch,
  projectId: string,
  body: UpdateProjectRequest
) {
  return apiFetch<UpdateProjectResponse>(
    fetchFn,
    `/api/v1/projects/${projectId}`,
    jsonMutation('PATCH', body)
  )
}

export type UpdateProjectTagsResponse = { id: string; tags: string[] }

// AC-P2: the only backend primitive is a full replace — this always sends the complete next
// tag set, mirroring the credential-tags PUT convention.
export function updateProjectTags(
  fetchFn: typeof fetch,
  projectId: string,
  tags: string[]
): Promise<UpdateProjectTagsResponse> {
  return apiFetch<UpdateProjectTagsResponse>(fetchFn, `/api/v1/projects/${projectId}/tags`, {
    method: 'PUT',
    body: JSON.stringify({ tags }),
  })
}
