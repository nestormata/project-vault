import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import type { Component } from 'svelte'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

// Story 69.10: the forwarding panel's sections are sub-regions. For each one a probe contribution
// must land BETWEEN the two PV sections it was meant to sit between (not at the end of the page),
// and the state the sections share (the chosen type, both forms' values) keeps one owner.

vi.mock('$app/state', () => ({
  page: { route: { id: '/(app)/settings/audit/forwarding' }, params: {} },
}))
vi.mock('$lib/api/audit.js', () => ({
  updateAuditForwarding: vi.fn(),
  updateAuditRetention: vi.fn(),
}))

const POINTS = [
  'settings.audit-forwarding.forwarder',
  'settings.audit-forwarding.type',
  'settings.audit-forwarding.webhook',
  'settings.audit-forwarding.s3',
  'settings.audit-forwarding.s3-destination',
  'settings.audit-forwarding.s3-credentials',
  'settings.audit-forwarding.retention',
] as const

let Panel: Component<Record<string, unknown>>
const fills = Object.fromEntries(POINTS.map((point) => [point, [{ marker: `fill:${point}` }]]))

beforeAll(async () => {
  const probe = (await import('$lib/test/injection/Probe.svelte')).default
  for (const point of POINTS) {
    vi.doMock(`virtual:pv-inject/${point}`, () => ({
      default: [{ id: `${point}#0`, order: 0, component: probe }],
    }))
  }
  Panel = (await import('./AuditForwardingPanel.svelte')).default as unknown as typeof Panel
}, 60_000)
afterEach(cleanup)

const mount = (allowed = true) => render(Panel, { props: { allowed, data: fills } })
const probe = (point: string): HTMLElement => {
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
const choose = (label: RegExp) => fireEvent.click(screen.getByLabelText(label))

describe('AuditForwardingPanel sub-regions (AC-4 probe order)', () => {
  it('type: after the type help, before the webhook form', () => {
    mount()
    expect(follows(byId('forwarder-type-help'), probe('settings.audit-forwarding.type'))).toBe(true)
    expect(follows(probe('settings.audit-forwarding.type'), byId('webhook-url'))).toBe(true)
  })

  it('webhook: after its save button, before the end of the Forwarding card and Retention', () => {
    mount()
    const save = screen.getByRole('button', { name: 'Save webhook' })
    expect(follows(save, probe('settings.audit-forwarding.webhook'))).toBe(true)
    expect(follows(probe('settings.audit-forwarding.webhook'), heading('Retention'))).toBe(true)
  })

  it('forwarder: after the form it hosts, before the Retention card', () => {
    mount()
    expect(
      follows(
        probe('settings.audit-forwarding.webhook'),
        probe('settings.audit-forwarding.forwarder')
      )
    ).toBe(true)
    expect(follows(probe('settings.audit-forwarding.forwarder'), heading('Retention'))).toBe(true)
  })

  it('retention: after the save button, last on the page', () => {
    mount()
    const save = screen.getByRole('button', { name: 'Save retention' })
    expect(follows(save, probe('settings.audit-forwarding.retention'))).toBe(true)
  })

  it('s3: destination sits between region and access key, credentials between secret key and prefix', async () => {
    mount()
    await choose(/s3-compatible/i)
    const destination = probe('settings.audit-forwarding.s3-destination')
    const credentials = probe('settings.audit-forwarding.s3-credentials')
    expect(follows(byId('s3-region'), destination)).toBe(true)
    expect(follows(destination, byId('s3-access-key'))).toBe(true)
    expect(follows(byId('s3-secret-key'), credentials)).toBe(true)
    expect(follows(credentials, byId('s3-prefix'))).toBe(true)
    expect(
      follows(
        screen.getByRole('button', { name: 'Save S3' }),
        probe('settings.audit-forwarding.s3')
      )
    ).toBe(true)
    expect(document.getElementById('webhook-url')).toBeNull()
  })

  it('renders no sub-region for a caller without the admin role', () => {
    mount(false)
    expect(screen.queryAllByTestId('probe')).toHaveLength(0)
    expect(screen.getByText(/requires the admin role/i)).toBeTruthy()
  })
})

describe('AuditForwardingPanel shared state (AC-4 interaction)', () => {
  it('keeps the webhook and S3 values when switching the type back and forth', async () => {
    mount()
    await fireEvent.input(byId('webhook-url'), {
      target: { value: 'https://siem.example.com/in' },
    })
    await choose(/s3-compatible/i)
    expect(document.getElementById('webhook-url')).toBeNull()
    await fireEvent.input(byId('s3-bucket'), { target: { value: 'audit-bucket' } })
    await choose(/^webhook$/i)
    expect((byId('webhook-url') as HTMLInputElement).value).toBe('https://siem.example.com/in')
    await choose(/s3-compatible/i)
    expect((byId('s3-bucket') as HTMLInputElement).value).toBe('audit-bucket')
  })

  it('rejects a non-https webhook client-side without calling the API', async () => {
    const { updateAuditForwarding } = await import('$lib/api/audit.js')
    mount()
    await fireEvent.input(byId('webhook-url'), {
      target: { value: 'http://insecure.example.com' },
    })
    await fireEvent.click(screen.getByRole('button', { name: 'Save webhook' }))
    expect(screen.getByRole('alert').textContent).toContain('URL must use https://')
    expect(updateAuditForwarding).not.toHaveBeenCalled()
  })

  it('clears the S3 key fields (and only those) after a successful save', async () => {
    const { updateAuditForwarding } = await import('$lib/api/audit.js')
    vi.mocked(updateAuditForwarding).mockResolvedValue({
      type: 's3',
      enabled: true,
      configuredAt: '2026-07-07T14:02:00.000Z',
    } as never)
    mount()
    await choose(/s3-compatible/i)
    await fireEvent.input(byId('s3-bucket'), { target: { value: 'b' } })
    await fireEvent.input(byId('s3-access-key'), { target: { value: 'AK' } })
    await fireEvent.input(byId('s3-secret-key'), { target: { value: 'SK' } })
    await fireEvent.click(screen.getByRole('button', { name: 'Save S3' }))
    await screen.findByText(/Forwarding configured at/)
    expect((byId('s3-access-key') as HTMLInputElement).value).toBe('')
    expect((byId('s3-secret-key') as HTMLInputElement).value).toBe('')
    expect((byId('s3-bucket') as HTMLInputElement).value).toBe('b')
  })
})
