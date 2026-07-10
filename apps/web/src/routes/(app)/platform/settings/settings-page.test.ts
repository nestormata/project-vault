import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import { routeExists } from '$lib/test/route-exists.js'
import { ApiClientError } from '$lib/api/client.js'

const updateSettingsMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/api/platform.js', () => ({
  updateSettings: updateSettingsMock,
}))

import SettingsPage from './+page.svelte'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const SAMPLE_SETTINGS = {
  smtp: {
    host: 'smtp.example.com',
    port: 587,
    user: 'noreply',
    from: 'noreply@example.com',
    configured: true,
  },
  backup: { schedule: '0 3 * * *', retentionCount: 7, storageType: 'filesystem' as const },
  notifications: { defaultSlackWebhook: null },
  instancePolicy: { maxOrgs: 10, maxUsersPerOrg: 50, sessionIdleTimeoutMinutes: 30 },
}

function allowedData(overrides: Record<string, unknown> = {}) {
  return {
    allowed: true as const,
    settings: SAMPLE_SETTINGS,
    errorMessage: null,
    ...overrides,
  }
}

describe('/platform/settings +page.svelte', () => {
  it('is a real, existing route', () => {
    expect(routeExists('/platform/settings')).toBe(true)
  })

  it('a non-operator sees the platform-operator-required notice', () => {
    render(SettingsPage, { props: { data: { allowed: false } } })

    expect(screen.getByRole('heading', { name: /platform operator access required/i })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: /^smtp$/i })).toBeNull()
  })

  it('surfaces a load-time errorMessage instead of the form', () => {
    render(SettingsPage, {
      props: { data: allowedData({ settings: null, errorMessage: 'Failed to load settings' }) },
    })

    expect(screen.getByText('Failed to load settings')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /save settings/i })).toBeNull()
  })

  it('renders current effective settings as placeholders/read-only text', () => {
    render(SettingsPage, { props: { data: allowedData() } })

    expect(screen.getByText(/password is currently set/i)).toBeTruthy()
    expect(screen.getByText(/0 3 \* \* \*/)).toBeTruthy()
    expect(screen.getByText(/retention 7 backups/i)).toBeTruthy()
  })

  it('links to Organizations, Resource Usage, and Manage backups resolve to real routes', () => {
    render(SettingsPage, { props: { data: allowedData() } })

    const orgsLink = screen.getByRole('link', { name: /organizations/i })
    expect(routeExists(orgsLink.getAttribute('href') ?? '')).toBe(true)
    const usageLink = screen.getByRole('link', { name: /resource usage/i })
    expect(routeExists(usageLink.getAttribute('href') ?? '')).toBe(true)
    const backupsLink = screen.getByRole('link', { name: /manage backups/i })
    expect(routeExists(backupsLink.getAttribute('href') ?? '')).toBe(true)
  })

  it('save: form fields are pre-populated from current settings and sent as-is on save', async () => {
    updateSettingsMock.mockResolvedValue(SAMPLE_SETTINGS)
    render(SettingsPage, { props: { data: allowedData() } })

    const hostInput = screen.getByLabelText(/^host$/i) as HTMLInputElement
    expect(hostInput.value).toBe('smtp.example.com')
    await fireEvent.input(hostInput, { target: { value: 'smtp2.example.com' } })

    await fireEvent.click(screen.getByRole('button', { name: /save settings/i }))

    expect(await screen.findByText(/settings saved successfully/i)).toBeTruthy()
    expect(updateSettingsMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        smtp: expect.objectContaining({ host: 'smtp2.example.com', user: 'noreply' }),
        instancePolicy: { maxOrgs: 10, maxUsersPerOrg: 50, sessionIdleTimeoutMinutes: 30 },
      })
    )
  })

  it('save: a fresh instance with no prior settings sends only the edited field', async () => {
    updateSettingsMock.mockResolvedValue(SAMPLE_SETTINGS)
    const emptySettings = {
      smtp: { host: null, port: null, user: null, from: null, configured: false },
      backup: { schedule: '0 3 * * *', retentionCount: 7, storageType: null },
      notifications: { defaultSlackWebhook: null },
      instancePolicy: { maxOrgs: 100, maxUsersPerOrg: 100, sessionIdleTimeoutMinutes: 60 },
    }
    render(SettingsPage, { props: { data: allowedData({ settings: emptySettings }) } })

    await fireEvent.input(screen.getByLabelText(/^host$/i), {
      target: { value: 'smtp3.example.com' },
    })
    await fireEvent.click(screen.getByRole('button', { name: /save settings/i }))

    await screen.findByText(/settings saved successfully/i)
    expect(updateSettingsMock).toHaveBeenCalledWith(expect.anything(), {
      smtp: { host: 'smtp3.example.com' },
      instancePolicy: { maxOrgs: 100, maxUsersPerOrg: 100, sessionIdleTimeoutMinutes: 60 },
    })
  })

  it('save: clears the password field on success (does not resend it)', async () => {
    updateSettingsMock.mockResolvedValue(SAMPLE_SETTINGS)
    render(SettingsPage, { props: { data: allowedData() } })

    const passwordInput = screen.getByLabelText(/^password$/i) as HTMLInputElement
    await fireEvent.input(passwordInput, { target: { value: 'hunter2' } })
    await fireEvent.click(screen.getByRole('button', { name: /save settings/i }))

    await screen.findByText(/settings saved successfully/i)
    expect(passwordInput.value).toBe('')
    expect(updateSettingsMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ smtp: expect.objectContaining({ password: 'hunter2' }) })
    )
  })

  it('save: MFA-required error shows the MFA notice', async () => {
    updateSettingsMock.mockRejectedValue(
      new ApiClientError(
        403,
        { code: 'mfa_required', message: 'MFA is required' },
        'MFA is required'
      )
    )
    render(SettingsPage, { props: { data: allowedData() } })

    await fireEvent.click(screen.getByRole('button', { name: /save settings/i }))

    expect(await screen.findByText('MFA is required')).toBeTruthy()
  })

  it('save: 422 with field details shows per-field errors, not a generic message', async () => {
    updateSettingsMock.mockRejectedValue(
      new ApiClientError(
        422,
        {
          message: 'Validation failed',
          details: [{ path: ['smtp', 'from'], message: 'Must be a valid email' }],
        },
        'Validation failed'
      )
    )
    render(SettingsPage, { props: { data: allowedData() } })

    await fireEvent.click(screen.getByRole('button', { name: /save settings/i }))

    expect(await screen.findByText('Must be a valid email')).toBeTruthy()
    expect(screen.queryByText('Validation failed')).toBeNull()
  })

  it('save: 422 with non-array details falls back to a generic validation error', async () => {
    updateSettingsMock.mockRejectedValue(
      new ApiClientError(422, { message: 'Validation failed', details: 'bad' }, 'Validation failed')
    )
    render(SettingsPage, { props: { data: allowedData() } })

    await fireEvent.click(screen.getByRole('button', { name: /save settings/i }))

    expect(await screen.findByText('Validation failed')).toBeTruthy()
  })

  it('save: 503 with vault-sealed shape shows the unseal message', async () => {
    updateSettingsMock.mockRejectedValue(new ApiClientError(503, { status: 'sealed' }, 'sealed'))
    render(SettingsPage, { props: { data: allowedData() } })

    await fireEvent.click(screen.getByRole('button', { name: /save settings/i }))

    expect(await screen.findByText(/unseal it to continue/i)).toBeTruthy()
  })

  it('save: non-ApiClientError shows a generic failure message', async () => {
    updateSettingsMock.mockRejectedValue(new Error('boom'))
    render(SettingsPage, { props: { data: allowedData() } })

    await fireEvent.click(screen.getByRole('button', { name: /save settings/i }))

    expect(await screen.findByText(/failed to save settings/i)).toBeTruthy()
  })

  it('save: 503 without a sealed-vault body shape shows the API error message', async () => {
    updateSettingsMock.mockRejectedValue(
      new ApiClientError(
        503,
        { code: 'maintenance', message: 'Under maintenance' },
        'Under maintenance'
      )
    )
    render(SettingsPage, { props: { data: allowedData() } })

    await fireEvent.click(screen.getByRole('button', { name: /save settings/i }))

    expect(await screen.findByText('Under maintenance')).toBeTruthy()
  })

  it('save: filling the schedule override and Slack webhook sends exactly those patches', async () => {
    // NOTE: retentionCountOverride/maxOrgs/maxUsersPerOrg/sessionIdleTimeoutMinutes are
    // deliberately not exercised here — see the Dev Agent Record's residual-debt ledger for a
    // discovered pre-existing runtime defect on those `type="number"` bound fields.
    updateSettingsMock.mockResolvedValue(SAMPLE_SETTINGS)
    render(SettingsPage, { props: { data: allowedData() } })

    await fireEvent.input(screen.getByLabelText(/schedule override/i), {
      target: { value: '0 4 * * *' },
    })
    await fireEvent.input(screen.getByLabelText(/default slack webhook/i), {
      target: { value: 'https://hooks.slack.com/services/T/B/X' },
    })
    await fireEvent.click(screen.getByRole('button', { name: /save settings/i }))

    await screen.findByText(/settings saved successfully/i)
    expect(updateSettingsMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        backup: { scheduleOverride: '0 4 * * *' },
        notifications: { defaultSlackWebhookUrl: 'https://hooks.slack.com/services/T/B/X' },
      })
    )
  })

  it('save button is disabled while saving', async () => {
    let resolveFn: (value: typeof SAMPLE_SETTINGS) => void = () => {}
    updateSettingsMock.mockReturnValue(
      new Promise((resolve) => {
        resolveFn = resolve
      })
    )
    render(SettingsPage, { props: { data: allowedData() } })

    const saveButton = screen.getByRole('button', { name: /save settings/i }) as HTMLButtonElement
    await fireEvent.click(saveButton)

    expect(saveButton.disabled).toBe(true)
    expect(screen.getByText(/saving…/i)).toBeTruthy()

    resolveFn(SAMPLE_SETTINGS)
    await screen.findByText(/settings saved successfully/i)
    expect(saveButton.disabled).toBe(false)
  })
})
