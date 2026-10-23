import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import type { Component } from 'svelte'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Story 69.10: the system settings page's sections are sub-regions. A probe contribution lands
// BETWEEN the two PV sections it was meant to sit between; the form keeps ONE owner of its editing
// state and save outcome; the display-once status token never reaches a contribution.

const updateSettingsMock = vi.hoisted(() => vi.fn())
const generateMock = vi.hoisted(() => vi.fn())
vi.mock('$app/state', () => ({ page: { route: { id: '/(app)/platform/settings' }, params: {} } }))
vi.mock('$lib/api/platform.js', () => ({
  updateSettings: updateSettingsMock,
  generateStatusToken: generateMock,
  rotateStatusToken: vi.fn(),
  revokeStatusToken: vi.fn(),
  testStatusToken: vi.fn(),
}))

const POINTS = [
  'form',
  'save-status',
  'smtp',
  'smtp-server',
  'smtp-account',
  'backup',
  'notifications',
  'instance-policy',
  'status-token',
  'status-token-reveal',
  'status-token-state',
  'status-token-actions',
].map((name) => `platform.settings.${name}`)
const fills = Object.fromEntries(POINTS.map((point) => [point, [{ marker: `fill:${point}` }]]))
const SETTINGS = {
  smtp: { host: null, port: null, user: null, from: null, configured: false },
  backup: { schedule: '0 3 * * *', retentionCount: 7, storageType: null },
  notifications: { defaultSlackWebhook: null },
  instancePolicy: { maxOrgs: 10, maxUsersPerOrg: 50, sessionIdleTimeoutMinutes: 30 },
}
const pageData = (overrides: Record<string, unknown> = {}) => ({
  allowed: true,
  settings: SETTINGS,
  errorMessage: null,
  statusToken: { configured: false },
  statusTokenLoadFailed: false,
  ...overrides,
})

let Content: Component<Record<string, unknown>>
beforeAll(async () => {
  const probe = (await import('$lib/test/injection/Probe.svelte')).default
  for (const point of POINTS) {
    vi.doMock(`virtual:pv-inject/${point}`, () => ({
      default: [{ id: `${point}#0`, order: 0, component: probe }],
    }))
  }
  Content = (await import('./PlatformSettingsContent.svelte')).default as unknown as typeof Content
}, 60_000)
beforeEach(() => {
  updateSettingsMock.mockReset()
  generateMock.mockReset()
})
afterEach(cleanup)

const mount = (overrides: Record<string, unknown> = {}) =>
  render(Content, { props: { pageData: pageData(overrides), data: fills } })
const probe = (name: string): HTMLElement => {
  const point = `platform.settings.${name}`
  const found = screen
    .getAllByTestId('probe')
    .find((el) => el.textContent?.includes(`"fill:${point}"`))
  if (found === undefined) throw new Error(`no probe for ${point}`)
  return found
}
const follows = (a: Node, b: Node): boolean =>
  (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
const byId = (id: string): HTMLElement => document.getElementById(id) as HTMLElement
const heading = (name: string): HTMLElement => screen.getByRole('heading', { name })

describe('PlatformSettingsContent sub-regions (AC-4 probe order)', () => {
  it('smtp-server sits between the port field and the username field', () => {
    mount()
    expect(follows(byId('smtp-port-help'), probe('smtp-server'))).toBe(true)
    expect(follows(probe('smtp-server'), screen.getByText('Username'))).toBe(true)
  })

  it('smtp-account and smtp close the SMTP card before the Backup card', () => {
    mount()
    expect(follows(byId('smtp-password-help'), probe('smtp-account'))).toBe(true)
    expect(follows(probe('smtp-account'), probe('smtp'))).toBe(true)
    expect(follows(probe('smtp'), heading('Backup'))).toBe(true)
  })

  it('backup, notifications and instance-policy each close their own card', () => {
    mount()
    expect(follows(byId('backup-retention-help'), probe('backup'))).toBe(true)
    expect(follows(probe('backup'), heading('Notifications'))).toBe(true)
    expect(follows(byId('slack-webhook-help'), probe('notifications'))).toBe(true)
    expect(follows(probe('notifications'), heading('Instance Policy'))).toBe(true)
    expect(follows(byId('session-idle-help'), probe('instance-policy'))).toBe(true)
  })

  it('form: after the last card, before the Save settings button; save-status above the form', () => {
    mount()
    expect(follows(probe('instance-policy'), probe('form'))).toBe(true)
    expect(follows(probe('form'), screen.getByRole('button', { name: 'Save settings' }))).toBe(true)
    expect(follows(probe('save-status'), byId('smtp-host-help'))).toBe(true)
  })

  it('status-token sub-regions follow the form in order: state, actions, card', () => {
    mount()
    const state = probe('status-token-state')
    const actions = probe('status-token-actions')
    expect(follows(heading('Instance Policy'), state)).toBe(true)
    expect(follows(state, screen.getByRole('button', { name: /generate token/i }))).toBe(true)
    expect(follows(screen.getByRole('button', { name: /generate token/i }), actions)).toBe(true)
    expect(follows(actions, probe('status-token'))).toBe(true)
  })

  it('shows nothing for a caller who is not a platform operator', () => {
    render(Content, { props: { pageData: { allowed: false }, data: fills } })
    expect(screen.queryAllByTestId('probe')).toHaveLength(0)
  })
})

describe('PlatformSettingsContent shared state (AC-4 interaction)', () => {
  it('a rejected save shows the error above the form and keeps the typed values', async () => {
    updateSettingsMock.mockRejectedValue(new Error('boom'))
    mount()
    const host = screen.getByLabelText(/^Host/) as HTMLInputElement
    await fireEvent.input(host, { target: { value: 'smtp.example.test' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Save settings' }))
    const alert = await screen.findByText('Failed to save settings')
    expect(follows(alert, probe('smtp-server'))).toBe(true)
    expect(host.value).toBe('smtp.example.test')
  })

  it('generating a token reveals it once and never hands it to a contribution', async () => {
    generateMock.mockResolvedValue({
      token: 'plaintext-secret-token-value',
      createdAt: '2026-10-01T00:00:00.000Z',
    })
    mount()
    await fireEvent.click(screen.getByRole('button', { name: /generate token/i }))
    await waitFor(() => expect(screen.getByText('plaintext-secret-token-value')).toBeTruthy())
    const reveal = probe('status-token-reveal')
    expect(follows(screen.getByText('plaintext-secret-token-value'), reveal)).toBe(true)
    for (const el of screen.getAllByTestId('probe')) {
      expect(el.textContent).not.toContain('plaintext-secret-token-value')
    }
    expect(screen.getByTestId('status-token-state').textContent).toMatch(/^configured$/i)
  })
})
