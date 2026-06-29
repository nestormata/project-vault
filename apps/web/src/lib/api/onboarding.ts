import { apiFetch } from './client.js'

export type OnboardingStatus = {
  completed: boolean
  completedAt?: string
}

export function getOnboardingStatus(fetchFn: typeof fetch) {
  return apiFetch<OnboardingStatus>(fetchFn, '/api/v1/users/me/onboarding')
}

export function completeOnboarding(fetchFn: typeof fetch) {
  return apiFetch<{ completed: true; completedAt: string }>(
    fetchFn,
    '/api/v1/users/me/onboarding',
    {
      method: 'POST',
      body: JSON.stringify({ completed: true }),
    }
  )
}
