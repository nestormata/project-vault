import { randomUUID } from 'node:crypto'
import FormData from 'form-data'
import { expect } from 'vitest'
import type { createApp } from '../../app.js'
import {
  cookieHeader,
  initVaultForTest,
  registerAndLoginViaApi,
} from '../../__tests__/helpers/auth-test-helpers.js'
import { resetVaultForTest } from '../../__tests__/helpers/vault-test-cleanup.js'

export type CredentialRouteTestApp = Awaited<ReturnType<typeof createApp>>
type InitVault = Parameters<typeof initVaultForTest>[0]

export const SENTINEL_VALUE = 'sentinel-credential-value-never-leaks'

const DEFAULT_CREDENTIAL_BODY = { name: 'Test Key', value: SENTINEL_VALUE }

export async function createCredentialTestProject(
  app: CredentialRouteTestApp,
  cookies: Record<string, string>,
  slug: string
) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/projects',
    headers: { cookie: cookieHeader(cookies) },
    payload: { name: `Project ${slug}`, slug: `${slug}-${randomUUID().slice(0, 8)}` },
  })
  expect(response.statusCode).toBe(201)
  return response.json<{ data: { id: string } }>().data.id
}

export async function createCredentialViaApi(
  app: CredentialRouteTestApp,
  cookies: Record<string, string>,
  projectId: string,
  body: { name: string; value: string; [key: string]: unknown } = DEFAULT_CREDENTIAL_BODY
) {
  const response = await app.inject({
    method: 'POST',
    url: `/api/v1/projects/${projectId}/credentials`,
    headers: { cookie: cookieHeader(cookies) },
    payload: body,
  })
  expect(response.statusCode).toBe(201)
  return response.json<{ data: { id: string } }>().data
}

export function credentialDependenciesUrl(projectId: string, credentialId: string, suffix = '') {
  return `/api/v1/projects/${projectId}/credentials/${credentialId}/dependencies${suffix}`
}

export function credentialLifecycleUrl(projectId: string, credentialId: string) {
  return `/api/v1/projects/${projectId}/credentials/${credentialId}`
}

export async function addCredentialDependencyViaApi(
  app: CredentialRouteTestApp,
  cookies: Record<string, string>,
  projectId: string,
  credentialId: string,
  payload: Record<string, unknown>
) {
  return app.inject({
    method: 'POST',
    url: credentialDependenciesUrl(projectId, credentialId),
    headers: { cookie: cookieHeader(cookies) },
    payload,
  })
}

export async function bootCredentialRouteApp(
  createAppFn: typeof createApp,
  initVault: InitVault,
  passphrase: string
): Promise<CredentialRouteTestApp> {
  await resetVaultForTest()
  await initVaultForTest(initVault, passphrase)
  return createAppFn({ logger: false, vaultGuardEnabled: true })
}

export async function registerCredentialRouteOwners(
  app: CredentialRouteTestApp,
  password: string,
  labelPrefix: string
) {
  const owner = await registerAndLoginViaApi(app, {
    email: `${labelPrefix}-owner-${randomUUID()}@example.com`,
    password,
    orgName: `${labelPrefix} Owner ${randomUUID()}`,
  })
  const other = await registerAndLoginViaApi(app, {
    email: `${labelPrefix}-other-${randomUUID()}@example.com`,
    password,
    orgName: `${labelPrefix} Other ${randomUUID()}`,
  })
  return { owner, other }
}

export async function bootstrapCredentialRouteOwners(
  createAppFn: typeof createApp,
  initVault: InitVault,
  passphrase: string,
  password: string,
  labelPrefix: string
) {
  const app = await bootCredentialRouteApp(createAppFn, initVault, passphrase)
  const { owner, other } = await registerCredentialRouteOwners(app, password, labelPrefix)
  return { app, owner, other }
}

export async function listCredentialsViaApi(
  app: CredentialRouteTestApp,
  cookies: Record<string, string>,
  projectId: string
) {
  return app.inject({
    method: 'GET',
    url: `/api/v1/projects/${projectId}/credentials`,
    headers: { cookie: cookieHeader(cookies) },
  })
}

export function credentialHasDependencies(
  response: { json<T>(): T },
  credentialId: string
): boolean | undefined {
  return response
    .json<{ data: { items: { id: string; hasDependencies: boolean }[] } }>()
    .data.items.find((item) => item.id === credentialId)?.hasDependencies
}

export function credentialImportUrl(projectId: string, confirm = false) {
  return `/api/v1/projects/${projectId}/credentials/import${confirm ? '/confirm' : ''}`
}

export function buildImportMultipart(body: string, filename: string) {
  const form = new FormData()
  form.append('file', Buffer.from(body, 'utf8'), { filename, contentType: 'text/plain' })
  return {
    payload: form,
    headers: form.getHeaders(),
  }
}

export async function uploadCredentialImport(
  app: CredentialRouteTestApp,
  cookies: Record<string, string>,
  projectId: string,
  body: string,
  filename: string
) {
  const multipart = buildImportMultipart(body, filename)
  return app.inject({
    method: 'POST',
    url: credentialImportUrl(projectId),
    headers: { cookie: cookieHeader(cookies), ...multipart.headers },
    payload: multipart.payload,
  })
}

export async function confirmCredentialImport(
  app: CredentialRouteTestApp,
  cookies: Record<string, string>,
  projectId: string,
  payload: Record<string, unknown>
) {
  return app.inject({
    method: 'POST',
    url: credentialImportUrl(projectId, true),
    headers: { cookie: cookieHeader(cookies) },
    payload,
  })
}
