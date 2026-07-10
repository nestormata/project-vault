import { describe, expect, it, vi, beforeEach } from 'vitest'

const proxyApiRequestMock = vi.hoisted(() => vi.fn())

vi.mock('$lib/server/api-proxy.js', () => ({
  proxyApiRequest: proxyApiRequestMock,
}))

import { DELETE, GET, PATCH, POST, PUT } from './+server.js'

function makeRequestEvent(path: string | undefined) {
  const request = new Request('http://localhost/api/v1/whatever')
  return { params: { path }, request } as unknown as Parameters<typeof GET>[0]
}

describe('/api/v1/[...path] +server.ts', () => {
  beforeEach(() => {
    proxyApiRequestMock.mockReset()
    proxyApiRequestMock.mockResolvedValue(new Response(null, { status: 200 }))
  })

  it('forwards the matched path when params.path is defined', async () => {
    await GET(makeRequestEvent('projects/abc'))

    expect(proxyApiRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'projects/abc' })
    )
  })

  it('falls back to an empty string path when params.path is undefined', async () => {
    await POST(makeRequestEvent(undefined))

    expect(proxyApiRequestMock).toHaveBeenCalledWith(expect.objectContaining({ path: '' }))
  })

  it('wires up PUT, PATCH, and DELETE to the same proxy handler', async () => {
    await PUT(makeRequestEvent('a'))
    await PATCH(makeRequestEvent('b'))
    await DELETE(makeRequestEvent('c'))

    expect(proxyApiRequestMock).toHaveBeenCalledTimes(3)
  })
})
