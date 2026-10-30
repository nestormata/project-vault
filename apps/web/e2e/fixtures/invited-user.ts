import type { BrowserContext, Page } from '@playwright/test'
import { enrollMfaViaApi, signInInvitee } from './auth.js'
import { createInvitationViaApi } from './api.js'
import { extractTokenFromAcceptUrl, readLatestInvitationAcceptUrl } from './db.js'
import { uniqueEmail } from './ids.js'

/**
 * Invites a new user to the owner's project with `role`, accepts the invitation in a fresh browser
 * context and returns that user's signed-in page. Invitations need an MFA-enrolled owner, so the
 * owner is enrolled first. Shared by the journeys that need a second, lower-privileged person
 * (J42 member, J43 viewer).
 */
export async function inviteAndSignIn(
  ownerContext: BrowserContext,
  browser: { newContext: () => Promise<BrowserContext> },
  input: { projectId: string; role: 'admin' | 'member' | 'viewer'; label: string; password: string }
): Promise<{ page: Page; email: string }> {
  await enrollMfaViaApi(ownerContext)
  const email = uniqueEmail(input.label)
  await createInvitationViaApi(ownerContext, input.projectId, { email, role: input.role })
  const token = extractTokenFromAcceptUrl(await readLatestInvitationAcceptUrl(email))
  const invitedContext = await browser.newContext()
  const page = await signInInvitee(invitedContext, email, token, input.password)
  return { page, email }
}
