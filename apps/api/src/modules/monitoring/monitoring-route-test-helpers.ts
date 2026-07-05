import { expect } from 'vitest'
import { cookieHeader, createProjectViaApi } from '../../__tests__/helpers/auth-test-helpers.js'

type InjectableApp = {
  inject: (opts: {
    method: string
    url: string
    headers?: Record<string, string>
  }) => Promise<{ statusCode: number; json: <T>() => T }>
}
type Cookies = Record<string, string>
type CreateFn<App> = (
  app: App,
  cookies: Cookies,
  projectId: string
) => Promise<{ statusCode: number; json: <T>() => T }>

/**
 * Shared by every monitoring-module create-route spec (payment/certificate/domain records,
 * service-endpoints): a project belonging to a different org must 404 as `project_not_found`,
 * never leak via a 403 or any other status. Lives here (matching the repo's `*test-helpers*`
 * jscpd-ignore glob) so structurally-identical assertions across resource-specific test files
 * don't trip the zero-duplication gate.
 */
export async function expectCrossOrgProjectNotFound<App extends InjectableApp>(
  app: App,
  ownerCookies: Cookies,
  otherCookies: Cookies,
  slugPrefix: string,
  createFn: CreateFn<App>
): Promise<void> {
  const otherProjectId = await createProjectViaApi(
    app as unknown as Parameters<typeof createProjectViaApi>[0],
    otherCookies,
    `${slugPrefix}-cross-org`
  )
  const res = await createFn(app, ownerCookies, otherProjectId)
  expect(res.statusCode).toBe(404)
  expect(res.json()).toMatchObject({ code: 'project_not_found' })
}

/** Shared archived-project write guard (ADR-4.4-01): every monitoring-module create route
 * must reject with 410 once the target project is archived. */
export async function expectArchivedProjectRejected<App extends InjectableApp>(
  app: App,
  ownerCookies: Cookies,
  slugPrefix: string,
  createFn: CreateFn<App>
): Promise<void> {
  const projectId = await createProjectViaApi(
    app as unknown as Parameters<typeof createProjectViaApi>[0],
    ownerCookies,
    `${slugPrefix}-archived`
  )
  const archiveRes = await app.inject({
    method: 'POST',
    url: `/api/v1/projects/${projectId}/archive`,
    headers: { cookie: cookieHeader(ownerCookies) },
  })
  expect(archiveRes.statusCode).toBe(200)

  const res = await createFn(app, ownerCookies, projectId)
  expect(res.statusCode).toBe(410)
}
