import { describe, expect, it } from 'vitest'
import { ApiClientError } from '$lib/api/client.js'
import { mapMonitoringSubmitError } from './form-errors.js'

describe('mapMonitoringSubmitError (AC-B3/C1/D1/E3 failure-mode mapping)', () => {
  it('maps a 422 with field-path details to per-field errors and keeps the server message as banner', () => {
    const error = new ApiClientError(
      422,
      {
        code: 'validation_error',
        message: 'Validation failed',
        details: { name: ['Name is required'] },
      },
      'Validation failed'
    )
    const result = mapMonitoringSubmitError(error, 'You do not have permission.')
    expect(result.fieldErrors).toEqual({ name: 'Name is required' })
    expect(result.errorMessage).toBe('Validation failed')
  })

  it('surfaces a message-only 422 (e.g. service_endpoint_limit_reached) verbatim with no field errors', () => {
    const error = new ApiClientError(
      422,
      {
        code: 'service_endpoint_limit_reached',
        message: 'This project has reached its maximum of 25 monitored endpoints',
      },
      'This project has reached its maximum of 25 monitored endpoints'
    )
    const result = mapMonitoringSubmitError(error, 'You do not have permission.')
    expect(result.fieldErrors).toEqual({})
    expect(result.errorMessage).toBe(
      'This project has reached its maximum of 25 monitored endpoints'
    )
  })

  it('surfaces the SSRF rejection message verbatim (AC-E3)', () => {
    const error = new ApiClientError(
      422,
      {
        code: 'url_not_allowed',
        message: 'URL resolves to a private, loopback, or reserved address and cannot be monitored',
      },
      'URL resolves to a private, loopback, or reserved address and cannot be monitored'
    )
    const result = mapMonitoringSubmitError(error, 'You do not have permission.')
    expect(result.errorMessage).toBe(
      'URL resolves to a private, loopback, or reserved address and cannot be monitored'
    )
  })

  it('maps 403 to the given forbidden message (stale-role mid-session downgrade)', () => {
    const error = new ApiClientError(403, { code: 'forbidden', message: 'Forbidden' }, 'Forbidden')
    const result = mapMonitoringSubmitError(
      error,
      'You do not have permission to manage this resource.'
    )
    expect(result.errorMessage).toBe('You do not have permission to manage this resource.')
    expect(result.fieldErrors).toEqual({})
  })

  it('maps 410 (archived project) to a clear, specific message (AC-B3 failure example)', () => {
    const error = new ApiClientError(
      410,
      { code: 'project_archived', message: 'Archived' },
      'Archived'
    )
    const result = mapMonitoringSubmitError(error, 'You do not have permission.')
    expect(result.errorMessage).toBe('This project is archived and cannot be modified.')
  })

  it('falls back to the raw ApiClientError message for any other status', () => {
    const error = new ApiClientError(500, null, 'Internal error')
    const result = mapMonitoringSubmitError(error, 'You do not have permission.')
    expect(result.errorMessage).toBe('Internal error')
  })

  it('handles a non-ApiClientError thrown value', () => {
    const result = mapMonitoringSubmitError(new Error('boom'), 'You do not have permission.')
    expect(result.errorMessage).toBe('boom')
    expect(result.fieldErrors).toEqual({})
  })
})
