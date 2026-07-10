import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte'
import { routeExists } from '$lib/test/route-exists.js'

const updateAuditForwardingMock = vi.hoisted(() => vi.fn())
const updateAuditRetentionMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/api/audit.js', () => ({
  updateAuditForwarding: updateAuditForwardingMock,
  updateAuditRetention: updateAuditRetentionMock,
}))

import { ApiClientError } from '$lib/api/client.js'
import ForwardingPage from './+page.svelte'

beforeEach(() => {
  updateAuditForwardingMock.mockReset()
  updateAuditRetentionMock.mockReset()
})

afterEach(() => cleanup())

function baseData(overrides: Record<string, unknown> = {}) {
  return { orgRole: 'admin', allowed: true as const, orgId: 'org-1', ...overrides }
}

describe('/settings/audit/forwarding +page.svelte', () => {
  it('is a real, existing route', () => {
    expect(routeExists('/settings/audit/forwarding')).toBe(true)
  })

  it('AC-N1: a member/viewer sees a role notice, no forms', () => {
    render(ForwardingPage, { props: { data: { orgRole: 'member', allowed: false } } })
    expect(screen.getByText(/requires the admin role|requires .* admin/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /save webhook/i })).toBeNull()
  })

  it('AC-E4/F-equivalent: help copy states plainly that the current config is not shown; forms start empty', () => {
    render(ForwardingPage, { props: { data: baseData() } })

    expect(screen.getAllByText(/does not currently display your saved/i).length).toBeGreaterThan(0)
    expect((screen.getByLabelText(/webhook url/i) as HTMLInputElement).value).toBe('')
  })

  it('AC-E1 happy path: submits webhook config and shows configuredAt, not the secret', async () => {
    updateAuditForwardingMock.mockResolvedValue({
      type: 'webhook',
      enabled: true,
      configuredAt: '2026-07-07T14:02:00.000Z',
    })

    render(ForwardingPage, { props: { data: baseData() } })

    await fireEvent.input(screen.getByLabelText(/webhook url/i), {
      target: { value: 'https://siem.example.com/ingest' },
    })
    await fireEvent.input(screen.getByLabelText(/secret header/i), {
      target: { value: 'wh_secret_abc' },
    })
    await fireEvent.click(screen.getByRole('button', { name: /save webhook/i }))

    expect(updateAuditForwardingMock).toHaveBeenCalledWith(expect.anything(), {
      type: 'webhook',
      config: { url: 'https://siem.example.com/ingest', secretHeader: 'wh_secret_abc' },
    })
    expect(await screen.findByText(/webhook forwarding configured/i)).toBeTruthy()
    expect(screen.queryByText('wh_secret_abc')).toBeNull()
  })

  it('AC-E1: the secretHeader input is masked (type=password) with autocomplete off', () => {
    render(ForwardingPage, { props: { data: baseData() } })
    const input = screen.getByLabelText(/secret header/i) as HTMLInputElement
    expect(input.type).toBe('password')
    expect(input.autocomplete).toBe('off')
  })

  it('AC-E2: blocks a non-https webhook URL client-side, no network call', async () => {
    render(ForwardingPage, { props: { data: baseData() } })

    await fireEvent.input(screen.getByLabelText(/webhook url/i), {
      target: { value: 'http://siem.example.com/ingest' },
    })
    await fireEvent.input(screen.getByLabelText(/secret header/i), { target: { value: 'x' } })
    await fireEvent.click(screen.getByRole('button', { name: /save webhook/i }))

    expect(screen.getByText(/url must use https/i)).toBeTruthy()
    expect(updateAuditForwardingMock).not.toHaveBeenCalled()
  })

  it('AC-E2 server-caught SSRF: surfaces the exact 422 message', async () => {
    updateAuditForwardingMock.mockRejectedValue(
      new ApiClientError(
        422,
        {
          code: 'unsafe_forwarding_url',
          message:
            'URL resolves to a private, loopback, or reserved address and cannot be used for forwarding',
        },
        'URL resolves to a private, loopback, or reserved address and cannot be used for forwarding'
      )
    )

    render(ForwardingPage, { props: { data: baseData() } })
    await fireEvent.input(screen.getByLabelText(/webhook url/i), {
      target: { value: 'https://169.254.169.254/' },
    })
    await fireEvent.input(screen.getByLabelText(/secret header/i), { target: { value: 'x' } })
    await fireEvent.click(screen.getByRole('button', { name: /save webhook/i }))

    expect(
      await screen.findByText(
        'URL resolves to a private, loopback, or reserved address and cannot be used for forwarding'
      )
    ).toBeTruthy()
  })

  it('AC-E3 happy path: submits S3 config, both key fields cleared and never redisplayed after success', async () => {
    updateAuditForwardingMock.mockResolvedValue({
      type: 's3',
      enabled: true,
      configuredAt: '2026-07-07T14:02:00.000Z',
    })

    render(ForwardingPage, { props: { data: baseData() } })
    await fireEvent.click(screen.getByRole('radio', { name: /s3-compatible/i }))

    await fireEvent.input(screen.getByLabelText(/^bucket/i), {
      target: { value: 'org-audit-logs' },
    })
    await fireEvent.input(screen.getByLabelText(/^region/i), { target: { value: 'us-east-1' } })
    await fireEvent.input(screen.getByLabelText(/access key id/i), { target: { value: 'AKIA123' } })
    await fireEvent.input(screen.getByLabelText(/secret access key/i), {
      target: { value: 's3secret' },
    })
    await fireEvent.click(screen.getByRole('button', { name: /save s3/i }))

    expect(updateAuditForwardingMock).toHaveBeenCalledWith(expect.anything(), {
      type: 's3',
      config: {
        bucket: 'org-audit-logs',
        region: 'us-east-1',
        accessKeyId: 'AKIA123',
        secretAccessKey: 's3secret',
      },
    })
    expect(await screen.findByText(/s3 forwarding configured|forwarding configured/i)).toBeTruthy()
    expect((screen.getByLabelText(/access key id/i) as HTMLInputElement).value).toBe('')
    expect((screen.getByLabelText(/secret access key/i) as HTMLInputElement).value).toBe('')
  })

  it('AC-E3: accessKeyId and secretAccessKey inputs are masked', async () => {
    render(ForwardingPage, { props: { data: baseData() } })
    await fireEvent.click(screen.getByRole('radio', { name: /s3-compatible/i }))
    expect((screen.getByLabelText(/access key id/i) as HTMLInputElement).type).toBe('password')
    expect((screen.getByLabelText(/secret access key/i) as HTMLInputElement).type).toBe('password')
  })

  it('AC-F1 happy path: submits retentionDays and shows confirmation', async () => {
    updateAuditRetentionMock.mockResolvedValue({
      retentionDays: 400,
      updatedAt: '2026-07-07T00:00:00.000Z',
    })

    render(ForwardingPage, { props: { data: baseData() } })
    await fireEvent.input(screen.getByLabelText(/retention \(days\)/i), {
      target: { value: '400' },
    })
    await fireEvent.click(screen.getByRole('button', { name: /save retention/i }))

    expect(updateAuditRetentionMock).toHaveBeenCalledWith(expect.anything(), 400)
    expect(await screen.findByText(/retention set to 400 days/i)).toBeTruthy()
  })

  it('AC-F2: blocks an out-of-bounds retention value client-side', async () => {
    render(ForwardingPage, { props: { data: baseData() } })
    await fireEvent.input(screen.getByLabelText(/retention \(days\)/i), { target: { value: '10' } })
    await fireEvent.click(screen.getByRole('button', { name: /save retention/i }))

    expect(screen.getByText(/must be between 30 and 3,650 days/i)).toBeTruthy()
    expect(updateAuditRetentionMock).not.toHaveBeenCalled()
  })

  it('AC-F3: "retain forever" checkbox sends an explicit retentionDays: null', async () => {
    updateAuditRetentionMock.mockResolvedValue({
      retentionDays: null,
      updatedAt: '2026-07-07T00:00:00.000Z',
    })

    render(ForwardingPage, { props: { data: baseData() } })
    await fireEvent.click(screen.getByLabelText(/never automatically delete/i))
    await fireEvent.click(screen.getByRole('button', { name: /save retention/i }))

    expect(updateAuditRetentionMock).toHaveBeenCalledWith(expect.anything(), null)
    expect(await screen.findByText(/retained indefinitely/i)).toBeTruthy()
  })

  it('AC-O2 regression: no forwarding/retention copy implies a viewable current configuration', () => {
    render(ForwardingPage, { props: { data: baseData() } })
    const bodyText = document.body.textContent ?? ''
    expect(/current configuration/i.test(bodyText)).toBe(false)
    expect(/your saved (config|settings)/i.test(bodyText)).toBe(false)
  })

  it('blocks a non-https S3 endpoint client-side, no network call', async () => {
    render(ForwardingPage, { props: { data: baseData() } })
    await fireEvent.click(screen.getByRole('radio', { name: /s3-compatible/i }))
    await fireEvent.input(screen.getByLabelText(/^bucket/i), { target: { value: 'b' } })
    await fireEvent.input(screen.getByLabelText(/^region/i), { target: { value: 'r' } })
    await fireEvent.input(screen.getByLabelText(/access key id/i), { target: { value: 'k' } })
    await fireEvent.input(screen.getByLabelText(/secret access key/i), { target: { value: 's' } })
    await fireEvent.input(screen.getByLabelText(/endpoint/i), {
      target: { value: 'http://minio.local' },
    })
    await fireEvent.click(screen.getByRole('button', { name: /save s3/i }))

    expect(screen.getByText(/endpoint must use https/i)).toBeTruthy()
    expect(updateAuditForwardingMock).not.toHaveBeenCalled()
  })

  it('includes optional prefix and endpoint in the S3 config only when provided', async () => {
    updateAuditForwardingMock.mockResolvedValue({
      type: 's3',
      enabled: true,
      configuredAt: '2026-07-07T14:02:00.000Z',
    })
    render(ForwardingPage, { props: { data: baseData() } })
    await fireEvent.click(screen.getByRole('radio', { name: /s3-compatible/i }))
    await fireEvent.input(screen.getByLabelText(/^bucket/i), { target: { value: 'b' } })
    await fireEvent.input(screen.getByLabelText(/^region/i), { target: { value: 'r' } })
    await fireEvent.input(screen.getByLabelText(/access key id/i), { target: { value: 'k' } })
    await fireEvent.input(screen.getByLabelText(/secret access key/i), { target: { value: 's' } })
    await fireEvent.input(screen.getByLabelText(/prefix/i), { target: { value: 'org-1/' } })
    await fireEvent.input(screen.getByLabelText(/endpoint/i), {
      target: { value: 'https://minio.local' },
    })
    await fireEvent.click(screen.getByRole('button', { name: /save s3/i }))

    expect(updateAuditForwardingMock).toHaveBeenCalledWith(expect.anything(), {
      type: 's3',
      config: {
        bucket: 'b',
        region: 'r',
        accessKeyId: 'k',
        secretAccessKey: 's',
        prefix: 'org-1/',
        endpoint: 'https://minio.local',
      },
    })
  })

  it('S3 config failure shows the API error message', async () => {
    updateAuditForwardingMock.mockRejectedValue(new ApiClientError(422, {}, 'invalid bucket'))
    render(ForwardingPage, { props: { data: baseData() } })
    await fireEvent.click(screen.getByRole('radio', { name: /s3-compatible/i }))
    await fireEvent.input(screen.getByLabelText(/^bucket/i), { target: { value: 'b' } })
    await fireEvent.input(screen.getByLabelText(/^region/i), { target: { value: 'r' } })
    await fireEvent.input(screen.getByLabelText(/access key id/i), { target: { value: 'k' } })
    await fireEvent.input(screen.getByLabelText(/secret access key/i), { target: { value: 's' } })
    await fireEvent.click(screen.getByRole('button', { name: /save s3/i }))

    expect(await screen.findByText('invalid bucket')).toBeTruthy()
  })

  it('a non-ApiClientError S3 failure shows the generic S3 error message', async () => {
    updateAuditForwardingMock.mockRejectedValue(new Error('network down'))
    render(ForwardingPage, { props: { data: baseData() } })
    await fireEvent.click(screen.getByRole('radio', { name: /s3-compatible/i }))
    await fireEvent.input(screen.getByLabelText(/^bucket/i), { target: { value: 'b' } })
    await fireEvent.input(screen.getByLabelText(/^region/i), { target: { value: 'r' } })
    await fireEvent.input(screen.getByLabelText(/access key id/i), { target: { value: 'k' } })
    await fireEvent.input(screen.getByLabelText(/secret access key/i), { target: { value: 's' } })
    await fireEvent.click(screen.getByRole('button', { name: /save s3/i }))

    expect(await screen.findByText(/^failed to configure s3 forwarding$/i)).toBeTruthy()
  })

  it('a non-ApiClientError webhook failure shows the generic webhook error message', async () => {
    updateAuditForwardingMock.mockRejectedValue(new Error('network down'))
    render(ForwardingPage, { props: { data: baseData() } })
    await fireEvent.input(screen.getByLabelText(/webhook url/i), {
      target: { value: 'https://example.com/hook' },
    })
    await fireEvent.click(screen.getByRole('button', { name: /save webhook/i }))

    expect(await screen.findByText(/^failed to configure webhook forwarding$/i)).toBeTruthy()
  })

  it('a non-ApiClientError retention failure shows the generic retention error message', async () => {
    updateAuditRetentionMock.mockRejectedValue(new Error('network down'))
    render(ForwardingPage, { props: { data: baseData() } })
    await fireEvent.input(screen.getByLabelText(/retention \(days\)/i), {
      target: { value: '400' },
    })
    await fireEvent.click(screen.getByRole('button', { name: /save retention/i }))

    expect(await screen.findByText(/^failed to update retention$/i)).toBeTruthy()
  })
})
