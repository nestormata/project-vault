import { describe, expect, it, vi } from 'vitest'
import { OperationalEvent, SYSTEM_TRACE_ID } from '@project-vault/shared'
import { logStartupFailure } from './startup-logging.js'

describe('logStartupFailure', () => {
  it('emits a structured startup.failed log and flushes before exit handling', async () => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      flush: vi.fn(),
    }
    const err = new Error('listen failed')

    await logStartupFailure(logger, err)

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: OperationalEvent.STARTUP_FAILED,
        traceId: SYSTEM_TRACE_ID,
        err: expect.objectContaining({ message: 'listen failed' }),
      }),
      'API startup failed'
    )
    expect(logger.flush).toHaveBeenCalledOnce()
  })
})
