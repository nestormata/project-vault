import { describe, expect, it } from 'vitest'
import { isLoopbackSocketAddress } from './loopback-address.js'

describe('isLoopbackSocketAddress (Story 43.9 AC-3 B3)', () => {
  it.each(['127.0.0.1', '::1', '::ffff:127.0.0.1'])(
    'accepts %s (the three forms a Node socket reports for a loopback peer)',
    (address) => {
      expect(isLoopbackSocketAddress(address)).toBe(true)
    }
  )

  // Documented equivalence widening: the same socket addresses written differently. A Node
  // socket's remoteAddress never renders these forms, so this is not reachable from a real peer.
  it.each(['::ffff:7f00:1', '0:0:0:0:0:0:0:1'])(
    'accepts %s (an alternate rendering of an accepted address)',
    (address) => {
      expect(isLoopbackSocketAddress(address)).toBe(true)
    }
  )

  it.each([
    ['127.0.0.2', 'exact match only, no 127/8 widening'],
    ['10.0.0.1', 'private, not loopback'],
    ['::2', 'next to ::1'],
    ['::', 'unspecified'],
    ['unknown-socket', "status.ts's sentinel for a destroyed socket"],
    ['', 'empty'],
    ['localhost', 'a hostname, not an address'],
  ])('rejects %j (%s)', (address) => {
    expect(isLoopbackSocketAddress(address)).toBe(false)
  })
})
