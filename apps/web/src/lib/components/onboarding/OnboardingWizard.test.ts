import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/svelte'
import OnboardingWizard from './OnboardingWizard.svelte'
import {
  credentialCreateSuccess,
  CREDENTIAL_VALUE_LABEL,
  fillCredentialForm,
  goToCredentialStep,
  installFetchMock,
  onboardingTestProject,
  onboardingTestUser,
} from './onboarding-test-helpers.js'

function renderWizard(
  overrides: {
    user?: typeof onboardingTestUser
    oncompleted?: () => void
  } = {}
) {
  return render(OnboardingWizard, {
    props: {
      user: overrides.user ?? onboardingTestUser,
      projects: [onboardingTestProject],
      oncompleted: overrides.oncompleted ?? vi.fn(),
    },
  })
}

describe('OnboardingWizard', () => {
  beforeEach(() => vi.restoreAllMocks())
  afterEach(() => cleanup())

  it('renders step 1 educational content without environment layer text', () => {
    renderWizard()
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByText(/Welcome to Project Vault/i)).toBeTruthy()
    expect(screen.getByText(/no environments/i)).toBeTruthy()
    expect(screen.queryByText(/^environment$/i)).toBeNull()
  })

  it('advances from step 1 to step 2', async () => {
    renderWizard()
    await goToCredentialStep(screen, fireEvent)
    expect(screen.getByText(/Add your first credential/i)).toBeTruthy()
  })

  it('blocks empty credential submission client-side', async () => {
    renderWizard()
    await goToCredentialStep(screen, fireEvent)
    await fireEvent.click(screen.getByRole('button', { name: /Save Credential/i }))
    expect(screen.getByText('Name is required')).toBeTruthy()
    expect(screen.getByText('Credential value cannot be empty')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Next' })).toHaveProperty('disabled', true)
  })

  it('enables Next after credential create succeeds and clears value state', async () => {
    installFetchMock((url, init) => {
      if (String(url).includes('/credentials') && init?.method === 'POST')
        return credentialCreateSuccess()
      return new Response(JSON.stringify({ completed: false }), { status: 200 })
    })

    renderWizard()
    await goToCredentialStep(screen, fireEvent)
    await fillCredentialForm(screen, fireEvent, { name: 'MY_API_KEY', value: 'sk_live_abc123' })
    await fireEvent.click(screen.getByRole('button', { name: /Save Credential/i }))

    expect(await screen.findByText(/Credential saved securely/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Next' })).toHaveProperty('disabled', false)
    expect((screen.getByLabelText(CREDENTIAL_VALUE_LABEL) as HTMLInputElement).value).toBe('')
  })

  it('shows vault sealed message on 503 credential errors', async () => {
    installFetchMock((url, init) => {
      if (String(url).includes('/credentials') && init?.method === 'POST') {
        return new Response(JSON.stringify({ code: 'vault_sealed', message: 'sealed' }), {
          status: 503,
        })
      }
      return new Response(JSON.stringify({ completed: false }), { status: 200 })
    })

    renderWizard()
    await goToCredentialStep(screen, fireEvent)
    await fillCredentialForm(screen, fireEvent, { name: 'MY_API_KEY', value: 'secret' })
    await fireEvent.click(screen.getByRole('button', { name: /Save Credential/i }))
    expect(await screen.findByText(/vault is sealed/i)).toBeTruthy()
  })

  it('shows viewer alternate path without credential form', async () => {
    renderWizard({ user: { ...onboardingTestUser, orgRole: 'viewer' } })
    await goToCredentialStep(screen, fireEvent)
    expect(screen.getByText(/Credential creation requires Member access/i)).toBeTruthy()
    expect(screen.queryByLabelText(CREDENTIAL_VALUE_LABEL)).toBeNull()
  })

  it('treats onboarding 409 as success on finish', async () => {
    const oncompleted = vi.fn()
    installFetchMock((url, init) => {
      if (String(url).includes('/users/me/onboarding') && init?.method === 'POST') {
        return new Response(
          JSON.stringify({ code: 'onboarding_already_completed', message: 'done' }),
          {
            status: 409,
          }
        )
      }
      if (String(url).includes('/credentials') && init?.method === 'POST')
        return credentialCreateSuccess()
      return new Response(JSON.stringify({ completed: false }), { status: 200 })
    })

    renderWizard({ oncompleted })
    await goToCredentialStep(screen, fireEvent)
    await fillCredentialForm(screen, fireEvent, { name: 'MY_API_KEY', value: 'secret' })
    await fireEvent.click(screen.getByRole('button', { name: /Save Credential/i }))
    await fireEvent.click(await screen.findByRole('button', { name: 'Next' }))
    await fireEvent.click(screen.getByRole('button', { name: /Go to Dashboard/i }))
    await vi.waitFor(() => expect(oncompleted).toHaveBeenCalled())
  })

  it('updates reveal toggle labels', async () => {
    renderWizard()
    await goToCredentialStep(screen, fireEvent)
    await fireEvent.click(screen.getByRole('button', { name: 'Show value' }))
    expect(screen.getByRole('button', { name: 'Hide value' })).toBeTruthy()
    expect((screen.getByLabelText('Credential value') as HTMLInputElement).type).toBe('text')
  })
})
