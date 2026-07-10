import { vi } from 'vitest'
import type { fireEvent, screen } from '@testing-library/dom'
import type { AuthUser } from '$lib/api/auth.js'

export const onboardingTestUser: AuthUser = {
  userId: 'user-1',
  orgId: 'org-1',
  orgName: 'Demo Org',
  sessionId: 'session-1',
  orgRole: 'owner',
  mfaEnrolled: false,
  mfaEnrolledAt: null,
  remainingRecoveryCodesCount: null,
  isPlatformOperator: false,
  mfaStatus: {
    enrollmentRequired: false,
    gracePeriodActive: false,
    gracePeriodExpiresAt: null,
    gracePeriodDaysRemaining: null,
    bannerMessage: null,
  },
}

export const onboardingTestProject = {
  id: 'project-1',
  name: 'Demo',
  slug: 'demo',
  description: null,
  role: 'owner' as const,
  createdAt: '',
}

export const GOT_IT_BUTTON = /Got it/i
export const CREDENTIAL_VALUE_LABEL = 'Credential value'
export const NAME_LABEL = /Name \(public identifier\)/i

export function installFetchMock(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>
) {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => Promise.resolve(handler(input, init)))
  )
}

export function credentialCreateSuccess() {
  return new Response(JSON.stringify({ data: { id: 'cred-1', name: 'MY_API_KEY' } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

type DomScreen = typeof screen
type DomFireEvent = typeof fireEvent

export async function goToCredentialStep(domScreen: DomScreen, domFireEvent: DomFireEvent) {
  // fireEvent may be sync (@testing-library/dom) or async (@testing-library/svelte).
  // Promise.resolve keeps the await always on a real Promise (typescript:S4123).
  await Promise.resolve(domFireEvent.click(domScreen.getByRole('button', { name: GOT_IT_BUTTON })))
}

export async function fillCredentialForm(
  domScreen: DomScreen,
  domFireEvent: DomFireEvent,
  input: { name: string; value: string }
) {
  await Promise.resolve(
    domFireEvent.input(domScreen.getByLabelText(NAME_LABEL), {
      target: { value: input.name },
    })
  )
  await Promise.resolve(
    domFireEvent.input(domScreen.getByLabelText(CREDENTIAL_VALUE_LABEL), {
      target: { value: input.value },
    })
  )
}
