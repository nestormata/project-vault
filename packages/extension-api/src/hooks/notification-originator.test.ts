import { describe, expect, it } from 'vitest'
import {
  NotificationOriginatorInvalidParamsError,
  NotificationOriginatorInvalidRecipientError,
  NotificationOriginatorNoAmbientContextError,
  NotificationOriginatorRateLimitedError,
  type NotificationOriginatorChannel,
  type NotificationOriginatorEnqueueForOrgParams,
  type NotificationOriginatorEnqueueParams,
  type NotificationOriginatorEnqueueResult,
  type NotificationOriginatorHost,
} from './notification-originator.js'

describe('notification-originator hook error classes (Story 36.1 AC1/AC3/AC4/AC5)', () => {
  it('NotificationOriginatorNoAmbientContextError has a stable code/name and mentions the method', () => {
    const error = new NotificationOriginatorNoAmbientContextError()
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('NotificationOriginatorNoAmbientContextError')
    expect(error.code).toBe('notification_originator_no_ambient_context')
    expect(error.message).toContain('enqueueNotification')
  })

  it('NotificationOriginatorInvalidParamsError carries the caller-provided detail message', () => {
    const error = new NotificationOriginatorInvalidParamsError('subject must be a non-empty string')
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('NotificationOriginatorInvalidParamsError')
    expect(error.code).toBe('notification_originator_invalid_params')
    expect(error.message).toContain('subject must be a non-empty string')
  })

  it('NotificationOriginatorInvalidRecipientError is non-enumerating — no distinguishable "not found" vs "not a member" text', () => {
    const error = new NotificationOriginatorInvalidRecipientError()
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('NotificationOriginatorInvalidRecipientError')
    expect(error.code).toBe('notification_originator_invalid_recipient')
    expect(error.message).not.toMatch(/not found/i)
    expect(error.message).toContain('active member')
  })

  it('NotificationOriginatorRateLimitedError has a stable code/name', () => {
    const error = new NotificationOriginatorRateLimitedError()
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('NotificationOriginatorRateLimitedError')
    expect(error.code).toBe('notification_originator_rate_limited')
  })

  it('every error is a plain Error subclass with own name/code, never sharing identity across classes', () => {
    const errors = [
      new NotificationOriginatorNoAmbientContextError(),
      new NotificationOriginatorInvalidParamsError('x'),
      new NotificationOriginatorInvalidRecipientError(),
      new NotificationOriginatorRateLimitedError(),
    ]
    const names = new Set(errors.map((e) => e.name))
    expect(names.size).toBe(errors.length)
  })
})

// Shared fixture literals — a constant avoids sonarjs/no-duplicate-string tripping on these
// values repeated across nearly every test case below.
const TEST_SUBJECT = 'Subject'
const TEST_BODY = 'Body'
const TEST_RECIPIENT_EMAIL = 'a@example.com'

describe('NotificationOriginatorHost type shape (AC1)', () => {
  it('accepts a structurally valid implementation and channel union', () => {
    const channels: NotificationOriginatorChannel[] = ['email', 'inbox']
    const host: NotificationOriginatorHost = {
      enqueueNotification: async (params: NotificationOriginatorEnqueueParams) => {
        const result: NotificationOriginatorEnqueueResult = { notificationQueueId: 'nq_1' }
        expect(channels).toContain(params.channel)
        return result
      },
      enqueueNotificationForOrg: async (params: NotificationOriginatorEnqueueForOrgParams) => {
        const result: NotificationOriginatorEnqueueResult = { notificationQueueId: 'nq_2' }
        expect(channels).toContain(params.channel)
        return result
      },
    }
    expect(typeof host.enqueueNotification).toBe('function')
    expect(typeof host.enqueueNotificationForOrg).toBe('function')
  })

  it('NotificationOriginatorEnqueueParams has no organizationId/orgId field (Design Decision 4/AC3)', () => {
    const params: NotificationOriginatorEnqueueParams = {
      channel: 'email',
      recipientEmail: TEST_RECIPIENT_EMAIL,
      subject: TEST_SUBJECT,
      body: TEST_BODY,
    }
    expect(Object.keys(params)).not.toContain('organizationId')
    expect(Object.keys(params)).not.toContain('orgId')
  })
})

describe('NotificationOriginatorEnqueueForOrgParams type shape (Story 58.1 AC1/Design Decision 1)', () => {
  it('is NotificationOriginatorEnqueueParams plus an explicit organizationId field', () => {
    const params: NotificationOriginatorEnqueueForOrgParams = {
      organizationId: 'org-1',
      channel: 'email',
      recipientUserId: 'user-1',
      subject: TEST_SUBJECT,
      body: TEST_BODY,
    }
    expect(params.organizationId).toBe('org-1')
    expect(Object.keys(params).sort()).toEqual(
      ['organizationId', 'channel', 'recipientUserId', 'subject', 'body'].sort()
    )
  })

  it('supports the same recipientUserId/recipientEmail optionality as the in-request params', () => {
    const params: NotificationOriginatorEnqueueForOrgParams = {
      organizationId: 'org-1',
      channel: 'email',
      recipientEmail: TEST_RECIPIENT_EMAIL,
      subject: TEST_SUBJECT,
      body: TEST_BODY,
    }
    expect(params.recipientUserId).toBeUndefined()
    expect(params.recipientEmail).toBe(TEST_RECIPIENT_EMAIL)
  })
})
