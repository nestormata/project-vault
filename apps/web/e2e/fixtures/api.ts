import type { BrowserContext } from '@playwright/test'
import { expect } from '@playwright/test'

// AC-I4/AC-J4-1's "UI is for validation only" principle: J2/J4's own subject under test is
// role-gating / the rotation flow, not project/credential/dependency creation (J1 already covers
// creation via the real UI) — so these journeys reach their starting state via direct API calls
// through the browser context's own authenticated cookie jar (context.request), matching
// registerAndLoginViaApi's same convention.

// Shared by every direct-API mutation below: POST, assert 2xx, unwrap the `{ data }` envelope
// (matching apps/web's own apiFetch/parseApiEnvelope convention).
async function postAndUnwrap<T>(context: BrowserContext, url: string, data: unknown): Promise<T> {
  const response = await context.request.post(url, { data })
  expect(response.ok(), await response.text()).toBeTruthy()
  const body = (await response.json()) as { data: T }
  return body.data
}

export async function createProjectViaApi(
  context: BrowserContext,
  opts: { name: string; slug: string }
): Promise<{ id: string; name: string }> {
  return postAndUnwrap(context, '/api/v1/projects', { name: opts.name, slug: opts.slug })
}

export async function createCredentialViaApi(
  context: BrowserContext,
  projectId: string,
  opts: { name: string; value: string }
): Promise<{ id: string; name: string }> {
  return postAndUnwrap(context, `/api/v1/projects/${projectId}/credentials`, {
    name: opts.name,
    value: opts.value,
  })
}

export async function addCredentialDependencyViaApi(
  context: BrowserContext,
  projectId: string,
  credentialId: string,
  opts: { systemName: string; systemType?: string }
): Promise<{ id: string }> {
  return postAndUnwrap(
    context,
    `/api/v1/projects/${projectId}/credentials/${credentialId}/dependencies`,
    { systemName: opts.systemName, systemType: opts.systemType ?? 'other' }
  )
}

export async function createInvitationViaApi(
  context: BrowserContext,
  projectId: string,
  opts: { email: string; role: 'admin' | 'member' | 'viewer' }
): Promise<void> {
  await postAndUnwrap(context, `/api/v1/projects/${projectId}/invitations`, {
    email: opts.email,
    role: opts.role,
  })
}
