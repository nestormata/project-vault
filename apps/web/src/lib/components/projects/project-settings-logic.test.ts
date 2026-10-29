import { describe, expect, it } from 'vitest'
import { ApiClientError } from '$lib/api/client.js'
import {
  deleteErrorOf,
  externalUrlParts,
  formatUrlLines,
  parseUrlLines,
  settingsErrorOf,
} from './project-settings-logic.js'

const fail = (status: number, body: Record<string, unknown> | null, message = 'boom') =>
  new ApiClientError(status, body as never, message)

describe('url lines', () => {
  it('splits on lines, trims and drops blanks, and round-trips', () => {
    expect(parseUrlLines(' https://a.example \n\n  \nhttp://b.example\n')).toEqual([
      'https://a.example',
      'http://b.example',
    ])
    expect(parseUrlLines('')).toEqual([])
    expect(formatUrlLines(['https://a.example', 'http://b.example'])).toBe(
      'https://a.example\nhttp://b.example'
    )
  })
})

describe('settingsErrorOf', () => {
  it('explains an archived project (410) and a missing authority (403)', () => {
    expect(settingsErrorOf(fail(410, null)).message).toMatch(/archived and read-only/)
    expect(settingsErrorOf(fail(403, null)).message).toMatch(
      /project owner or an organization owner/
    )
  })

  it('maps validation details to the field that failed', () => {
    const result = settingsErrorOf(
      fail(422, {
        code: 'validation_error',
        details: { 'urls.0': ['Must be an absolute http or https URL'], name: ['Too short'] },
      })
    )
    expect(result.fields).toEqual({
      urls: 'Must be an absolute http or https URL',
      name: 'Too short',
    })
    expect(result.message).toBe('Check the highlighted fields.')
  })

  it('keeps going when the validation details are missing or malformed', () => {
    expect(settingsErrorOf(fail(422, { code: 'validation_error' })).fields).toEqual({})
    expect(settingsErrorOf(fail(422, { details: { urls: 'nope' } as never })).fields).toEqual({})
  })

  it('falls back to the API message, then to a generic one', () => {
    expect(settingsErrorOf(fail(500, null, 'server down')).message).toBe('server down')
    expect(settingsErrorOf(fail(500, null, '')).message).toBe('The project could not be saved.')
    expect(settingsErrorOf(new Error('x')).message).toBe('The project could not be saved.')
  })
})

describe('deleteErrorOf', () => {
  it('names the blocker the API returned', () => {
    expect(
      deleteErrorOf(fail(409, { error: 'active_rotations', rotationIds: ['a', 'b'] }))
    ).toMatch(/2 in-progress rotation/)
    expect(deleteErrorOf(fail(409, { error: 'active_rotations' }))).toMatch(/0 in-progress/)
    expect(deleteErrorOf(fail(409, { error: 'active_machine_user_keys' }))).toMatch(
      /Revoke the keys/
    )
  })

  it('explains a missing authority and falls back', () => {
    expect(deleteErrorOf(fail(403, null))).toMatch(/project owner or an organization owner/)
    expect(deleteErrorOf(fail(500, null, 'server down'))).toBe('server down')
    expect(deleteErrorOf(fail(500, null, ''))).toBe('The project could not be deleted.')
    expect(deleteErrorOf('nope')).toBe('The project could not be deleted.')
  })
})

describe('externalUrlParts', () => {
  it('splits scheme and rest, and treats a bare address as https', () => {
    expect(externalUrlParts('https://wiki.example/a?b=1')).toEqual({
      scheme: 'https',
      rest: 'wiki.example/a?b=1',
    })
    expect(externalUrlParts('wiki.example')).toEqual({ scheme: 'https', rest: 'wiki.example' })
  })
})
