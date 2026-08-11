import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { ApiClientError } from '$lib/api/client.js'

const updateSettingsMock = vi.hoisted(() => vi.fn())
const generateStatusTokenMock = vi.hoisted(() => vi.fn())
const rotateStatusTokenMock = vi.hoisted(() => vi.fn())
const revokeStatusTokenMock = vi.hoisted(() => vi.fn())
const testStatusTokenMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/api/platform.js', () => ({
  updateSettings: updateSettingsMock,
  generateStatusToken: generateStatusTokenMock,
  rotateStatusToken: rotateStatusTokenMock,
  revokeStatusToken: revokeStatusTokenMock,
  testStatusToken: testStatusTokenMock,
}))

import SettingsPage from './+page.svelte'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

const SAMPLE_SETTINGS = {
  smtp: { host: null, port: null, user: null, from: null, configured: false },
  backup: { schedule: '0 3 * * *', retentionCount: 7, storageType: null },
  notifications: { defaultSlackWebhook: null },
  instancePolicy: { maxOrgs: 10, maxUsersPerOrg: 50, sessionIdleTimeoutMinutes: 30 },
}

function allowedData(overrides: Record<string, unknown> = {}) {
  return {
    allowed: true as const,
    settings: SAMPLE_SETTINGS,
    errorMessage: null,
    statusToken: { configured: false },
    ...overrides,
  }
}

describe('/platform/settings status-token section (Story 1.19 AC-5/AC-6)', () => {
  it('shows "Not configured" and a Generate button when no token exists', () => {
    render(SettingsPage, { props: { data: allowedData() } })

    expect(screen.getByTestId('status-token-state').textContent).toMatch(/not configured/i)
    expect(screen.getByRole('button', { name: /generate token/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^revoke$/i })).toBeNull()
  })

  it('generating a token reveals the plaintext exactly once and flips to Configured/Rotate', async () => {
    generateStatusTokenMock.mockResolvedValue({
      token: 'plaintext-secret-token-value',
      createdAt: new Date().toISOString(),
    })
    render(SettingsPage, { props: { data: allowedData() } })

    await fireEvent.click(screen.getByRole('button', { name: /generate token/i }))

    await waitFor(() => {
      expect(screen.getByText('plaintext-secret-token-value')).toBeTruthy()
    })
    expect(screen.getByTestId('status-token-state').textContent).toMatch(/^configured$/i)
    expect(screen.getByRole('button', { name: /rotate token/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^revoke$/i })).toBeTruthy()
  })

  it('revoking flips back to "Not configured" and clears the revealed token', async () => {
    revokeStatusTokenMock.mockResolvedValue(undefined)
    render(SettingsPage, {
      props: {
        data: allowedData({
          statusToken: { configured: true, createdAt: new Date().toISOString() },
        }),
      },
    })

    await fireEvent.click(screen.getByRole('button', { name: /^revoke$/i }))

    await waitFor(() => {
      expect(screen.getByTestId('status-token-state').textContent).toMatch(/not configured/i)
    })
    expect(revokeStatusTokenMock).toHaveBeenCalledTimes(1)
  })

  it('Test reports the live healthy/degraded/unavailable result', async () => {
    testStatusTokenMock.mockResolvedValue({
      status: 'degraded',
      checks: {
        database: { status: 'ok' },
        vault: { status: 'ok' },
        disk: { status: 'skipped' },
      },
    })
    render(SettingsPage, {
      props: { data: allowedData({ statusToken: { configured: true } }) },
    })

    await fireEvent.click(screen.getByRole('button', { name: /^test$/i }))

    await waitFor(() => {
      expect(screen.getByText(/degraded/i)).toBeTruthy()
    })
  })

  it('surfaces an API error message without crashing', async () => {
    generateStatusTokenMock.mockRejectedValue(new ApiClientError(500, null, 'Failed'))
    render(SettingsPage, { props: { data: allowedData() } })

    await fireEvent.click(screen.getByRole('button', { name: /generate token/i }))

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeTruthy()
    })
  })

  it('a rotate failure clears the previously revealed plaintext token', async () => {
    generateStatusTokenMock.mockResolvedValue({
      token: 'plaintext-secret-token-value',
      createdAt: new Date().toISOString(),
    })
    render(SettingsPage, { props: { data: allowedData() } })

    await fireEvent.click(screen.getByRole('button', { name: /generate token/i }))
    await waitFor(() => {
      expect(screen.getByText('plaintext-secret-token-value')).toBeTruthy()
    })

    rotateStatusTokenMock.mockRejectedValue(new ApiClientError(500, null, 'Rotate failed'))
    await fireEvent.click(screen.getByRole('button', { name: /rotate token/i }))

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeTruthy()
    })
    // Adversarial review fix: the stale plaintext from the earlier successful reveal must not
    // remain displayed next to the new error — it may already be invalidated.
    expect(screen.queryByText('plaintext-secret-token-value')).toBeNull()
  })

  it('renders a distinct "couldn\'t load" message when status-token metadata failed to load, instead of implying unconfigured', () => {
    render(SettingsPage, {
      props: { data: allowedData({ statusToken: null, statusTokenLoadFailed: true }) },
    })

    expect(screen.getAllByRole('alert').length).toBeGreaterThan(0)
    expect(screen.getByText(/couldn't load token status/i)).toBeTruthy()
  })

  it('surfaces an error when the clipboard write fails, instead of silently claiming success', async () => {
    generateStatusTokenMock.mockResolvedValue({
      token: 'plaintext-secret-token-value',
      createdAt: new Date().toISOString(),
    })
    const writeText = vi.fn().mockRejectedValue(new Error('denied'))
    Object.assign(navigator, { clipboard: { writeText } })

    render(SettingsPage, { props: { data: allowedData() } })
    await fireEvent.click(screen.getByRole('button', { name: /generate token/i }))
    await waitFor(() => {
      expect(screen.getByText('plaintext-secret-token-value')).toBeTruthy()
    })

    await fireEvent.click(screen.getByRole('button', { name: /copy/i }))

    await waitFor(() => {
      expect(screen.getByText(/could not copy to clipboard/i)).toBeTruthy()
    })
    expect(screen.queryByRole('button', { name: /copied/i })).toBeNull()
  })
})
