import { randomUUID } from 'node:crypto'
import type { TestApp } from './app-instance.js'
import { type CookieJar, cookieHeader, describeResponse } from './http.js'

/** Creates a real project via the real API, returning its ID. */
export async function createProject(app: TestApp, cookies: CookieJar): Promise<string> {
  const slug = `contract-test-${randomUUID().slice(0, 8)}`
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/projects',
    headers: { cookie: cookieHeader(cookies) },
    payload: { name: `Contract Test Project ${slug}`, slug },
  })
  if (res.statusCode !== 201) {
    throw new Error(`Contract test fixture project creation failed: ${describeResponse(res)}`)
  }
  return res.json<{ data: { id: string } }>().data.id
}

/** Creates a real credential inside `projectId` via the real API, returning its ID. */
export async function createCredential(
  app: TestApp,
  cookies: CookieJar,
  projectId: string
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/projects/${projectId}/credentials`,
    headers: { cookie: cookieHeader(cookies) },
    payload: {
      name: `contract-test-credential-${randomUUID().slice(0, 8)}`,
      value: 'sentinel-value',
    },
  })
  if (res.statusCode !== 201) {
    throw new Error(`Contract test fixture credential creation failed: ${describeResponse(res)}`)
  }
  return res.json<{ data: { id: string } }>().data.id
}
