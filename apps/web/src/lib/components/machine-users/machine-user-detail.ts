import { ApiClientError } from '$lib/api/client.js'

export type PointData = Record<string, readonly unknown[]> | undefined

export function formatDate(value: string | null): string {
  if (!value) return '—'
  return new Date(value).toLocaleString()
}

export function apiErrorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiClientError ? (error.message ?? fallback) : fallback
}
