import { afterEach, describe, expect, it } from 'vitest'
import { createMockBoss } from '../__tests__/helpers/notification-test-helpers.js'
import {
  __resetNotificationDispatchBossForTests,
  getNotificationDispatchBoss,
  registerNotificationDispatchBoss,
} from './notification-dispatch-boss.js'

// Story 70.2 AC2 — the process-wide BossService registry the originator host reads lazily.

afterEach(() => {
  __resetNotificationDispatchBossForTests()
})

describe('notification-dispatch-boss registry', () => {
  it('is empty until a boss is registered', () => {
    expect(getNotificationDispatchBoss()).toBeUndefined()
  })

  it('returns the registered boss', () => {
    const { boss } = createMockBoss()
    registerNotificationDispatchBoss(boss)
    expect(getNotificationDispatchBoss()).toBe(boss)
  })

  it('registering twice replaces the reference (last wins)', () => {
    const first = createMockBoss().boss
    const second = createMockBoss().boss
    registerNotificationDispatchBoss(first)
    registerNotificationDispatchBoss(second)
    expect(getNotificationDispatchBoss()).toBe(second)
  })

  it('reset empties the registry', () => {
    registerNotificationDispatchBoss(createMockBoss().boss)
    __resetNotificationDispatchBossForTests()
    expect(getNotificationDispatchBoss()).toBeUndefined()
  })
})
