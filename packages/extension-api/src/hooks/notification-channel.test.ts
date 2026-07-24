import { describe, expect, it } from 'vitest'
import type { NotificationChannel } from './notification-channel.js'

describe('NotificationChannel', () => {
  it('onNotify resolves void', async () => {
    let received: unknown
    const channel: NotificationChannel = {
      onNotify: (payload) => {
        received = payload
        return Promise.resolve()
      },
    }

    await expect(channel.onNotify({ subject: 'hello', body: 'world' })).resolves.toBeUndefined()
    expect(received).toEqual({ subject: 'hello', body: 'world' })
  })
})
