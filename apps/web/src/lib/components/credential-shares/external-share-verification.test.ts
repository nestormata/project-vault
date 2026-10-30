import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sendMock = vi.hoisted(() => vi.fn())
const confirmMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/api/credential-shares.js', () => ({
  sendExternalShareVerification: sendMock,
  confirmExternalShareVerification: confirmMock,
}))

import { ApiClientError } from '$lib/api/client.js'
import { ExternalShareVerificationController } from './external-share-verification.svelte.js'

function make(onVerified = vi.fn()) {
  const controller = new ExternalShareVerificationController({
    fetchFn: vi.fn() as unknown as typeof fetch,
    token: 'tok',
    initialMask: 'a***@b***',
    onVerified,
  })
  return { controller, onVerified }
}

describe('ExternalShareVerificationController (Story 72.11)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    sendMock.mockReset()
    confirmMock.mockReset()
  })
  afterEach(() => vi.useRealTimers())

  it('send marks the step requested and disables resend for cooldownSeconds, counting down', async () => {
    sendMock.mockResolvedValue({ maskedRecipient: 'n***@g***', cooldownSeconds: 3 })
    const { controller } = make()

    await controller.send()
    expect(controller.requested).toBe(true)
    expect(controller.maskedRecipient).toBe('n***@g***')
    expect(controller.cooldownRemaining).toBe(3)
    expect(controller.canResend).toBe(false)

    await controller.send()
    expect(sendMock).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(2000)
    expect(controller.cooldownRemaining).toBe(1)
    vi.advanceTimersByTime(1000)
    expect(controller.cooldownRemaining).toBe(0)
    expect(controller.canResend).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a failed send reports unavailable and leaves resend enabled', async () => {
    sendMock.mockRejectedValue(new Error('network'))
    const { controller } = make()
    await controller.send()
    expect(controller.failure).toBe('unavailable')
    expect(controller.requested).toBe(false)
    expect(controller.canResend).toBe(true)
  })

  it('confirm only runs for exactly six digits', () => {
    const { controller } = make()
    for (const code of ['', '12345', '1234567', '12345a']) {
      controller.code = code
      expect(controller.canConfirm).toBe(false)
    }
    controller.code = '123456'
    expect(controller.canConfirm).toBe(true)
  })

  it('a successful confirm hands the proof to the callback and clears the code', async () => {
    confirmMock.mockResolvedValue({ proof: 'proof-value' })
    const { controller, onVerified } = make()
    controller.code = '123456'
    await controller.confirm()
    expect(confirmMock).toHaveBeenCalledWith(expect.anything(), 'tok', '123456')
    expect(onVerified).toHaveBeenCalledWith('proof-value')
    expect(controller.code).toBe('')
  })

  it('a 422 is the generic failure, any other error is unavailable, and no proof is passed on', async () => {
    const { controller, onVerified } = make()
    controller.code = '000000'
    confirmMock.mockRejectedValueOnce(new ApiClientError(422, { code: 'verification_failed' }, 'x'))
    await controller.confirm()
    expect(controller.failure).toBe('failed')

    confirmMock.mockRejectedValueOnce(new ApiClientError(503, null, 'x'))
    await controller.confirm()
    expect(controller.failure).toBe('unavailable')
    expect(onVerified).not.toHaveBeenCalled()
  })

  it('dispose stops the countdown timer', async () => {
    sendMock.mockResolvedValue({ maskedRecipient: 'n***@g***', cooldownSeconds: 60 })
    const { controller } = make()
    await controller.send()
    expect(vi.getTimerCount()).toBe(1)
    controller.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })
})
