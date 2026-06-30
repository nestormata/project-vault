import { describe, expect, it, vi } from 'vitest'
import { runDigestSend } from './notification-digest.js'
import { resetEmailTransportForTesting, setEmailTransportForTesting } from './notification-email.js'

describe('notification digest worker', () => {
  it('skips when SMTP transport is unavailable', async () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }

    setEmailTransportForTesting(null)
    try {
      await runDigestSend(logger)
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: 'notification.digest.skipped' }),
        expect.any(String)
      )
    } finally {
      resetEmailTransportForTesting()
    }
  })
})
