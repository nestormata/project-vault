import type { ProjectDashboard, ProjectDetail, ProjectSummary } from '@project-vault/shared'
import { apiFetch } from './client.js'

export type CreateProjectRequest = {
  name: string
  slug: string
  description?: string | null
}

export type UpdateProjectRequest = {
  name?: string
  description?: string | null
}

export type UpdateProjectResponse = {
  id: string
  name: string
  slug: string
  description: string | null
  updatedAt: string
}

function jsonMutation(method: 'POST' | 'PATCH', body: unknown): RequestInit {
  return { method, body: JSON.stringify(body) }
}

export function suggestProjectSlug(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/g, '')
  return slug || 'project'
}

export function createProject(fetchFn: typeof fetch, body: CreateProjectRequest) {
  return apiFetch<ProjectDetail>(fetchFn, '/api/v1/projects', jsonMutation('POST', body))
}

export function listProjects(fetchFn: typeof fetch) {
  return apiFetch<{ items: ProjectSummary[]; total: number }>(fetchFn, '/api/v1/projects')
}

export function getProjectDashboard(fetchFn: typeof fetch, projectId: string) {
  return apiFetch<ProjectDashboard>(fetchFn, `/api/v1/projects/${projectId}/dashboard`)
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
