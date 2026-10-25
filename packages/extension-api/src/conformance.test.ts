import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import {
  assertExtensionEmittersContained,
  checkBackgroundPromisesHandled,
  checkExtensionEmitters,
  checkProjectWriteRoles,
} from './conformance.js'

describe('checkExtensionEmitters', () => {
  it('fails an emitter that has no error listener (the pg.Pool-without-listener class)', () => {
    const pool = new EventEmitter()
    const result = checkExtensionEmitters({ controlPlanePool: pool })
    expect(result.ok).toBe(false)
    expect(result.violations).toEqual(['controlPlanePool'])
  })

  it('passes an emitter that carries an error listener, and does not throw while forcing', () => {
    const pool = new EventEmitter()
    const seen: string[] = []
    pool.on('error', (err: Error) => seen.push(err.name))
    const result = checkExtensionEmitters({ controlPlanePool: pool })
    expect(result).toEqual({ ok: true, violations: [] })
    expect(seen).toEqual(['Error'])
  })

  it('reports every offending label and keeps the conforming ones out', () => {
    const good = new EventEmitter()
    good.on('error', () => undefined)
    const result = checkExtensionEmitters({ a: new EventEmitter(), good, b: new EventEmitter() })
    expect(result.violations).toEqual(['a', 'b'])
  })

  it('never puts error text in the violation output', () => {
    const result = checkExtensionEmitters({ pool: new EventEmitter() })
    expect(JSON.stringify(result)).not.toContain('postgres://')
  })
})

describe('assertExtensionEmittersContained', () => {
  it('throws naming only the offending labels', () => {
    expect(() => assertExtensionEmittersContained({ leaky: new EventEmitter() })).toThrow(/leaky/)
  })

  it('returns quietly when every emitter is covered', () => {
    const ok = new EventEmitter()
    ok.on('error', () => undefined)
    expect(() => assertExtensionEmittersContained({ ok })).not.toThrow()
  })
})

describe('checkBackgroundPromisesHandled', () => {
  it('flags a background promise that rejects with no handler', async () => {
    const result = await checkBackgroundPromisesHandled(() => {
      void Promise.reject(new Error('boom'))
    })
    expect(result).toEqual({ ok: false, unhandledCount: 1 })
  })

  it('passes when the rejection is handled', async () => {
    const result = await checkBackgroundPromisesHandled(async () => {
      await Promise.reject(new Error('boom')).catch(() => undefined)
    })
    expect(result).toEqual({ ok: true, unhandledCount: 0 })
  })

  it('removes its listener afterwards', async () => {
    const before = process.listenerCount('unhandledRejection')
    await checkBackgroundPromisesHandled(() => undefined)
    expect(process.listenerCount('unhandledRejection')).toBe(before)
  })
})

describe('checkProjectWriteRoles (Story 69.18)', () => {
  const add = (method: string, url: string, security?: object) => ({
    method,
    url,
    ...(security ? { options: { security } } : {}),
  })
  const manifest = (apiVersion: string) => ({
    apiVersion,
    apiRoutes: {
      add: [
        add('POST', '/cm/projects/:projectId/notes'),
        add('POST', '/cm/projects/:projectId/notes/revoke', { minimumProjectRole: 'viewer' }),
        add('DELETE', '/cm/projects/:projectId/notes/all', { minimumProjectRole: 'admin' }),
        add('POST', '/cm/projects/:projectId/hook', { requireAuth: false }),
        add('GET', '/cm/projects/:projectId/notes'),
        add('POST', '/cm/folders/:folderId'),
      ],
      override: [
        { method: 'POST', url: '/api/v1/projects/:projectId/archive', mode: 'replace' },
        {
          method: 'POST',
          url: '/api/v1/projects/:projectId/unarchive',
          mode: 'replace',
          replaceSecurity: true,
          security: {},
        },
      ],
    },
  })

  it('reports the gate the host applies to each owned project write on the current contract', () => {
    expect(checkProjectWriteRoles(manifest('3.37.0'))).toEqual({
      ok: false,
      routes: [
        {
          route: 'POST /cm/projects/:projectId/notes',
          minimumProjectRole: 'member',
          ungated: null,
        },
        {
          route: 'POST /cm/projects/:projectId/notes/revoke',
          minimumProjectRole: null,
          ungated: 'declared_viewer',
        },
        {
          route: 'DELETE /cm/projects/:projectId/notes/all',
          minimumProjectRole: 'admin',
          ungated: null,
        },
        {
          route: 'POST /cm/projects/:projectId/hook',
          minimumProjectRole: null,
          ungated: 'unauthenticated',
        },
        {
          route: 'POST /api/v1/projects/:projectId/unarchive',
          minimumProjectRole: 'member',
          ungated: null,
        },
      ],
    })
  })

  it('flags every undeclared project write of an older manifest as legacy_contract', () => {
    const { routes } = checkProjectWriteRoles(manifest('3.36.0'))
    expect(
      routes.filter((route) => route.ungated === 'legacy_contract').map((r) => r.route)
    ).toEqual([
      'POST /cm/projects/:projectId/notes',
      'POST /cm/projects/:projectId/hook',
      'POST /api/v1/projects/:projectId/unarchive',
    ])
  })

  it('is ok for a manifest whose project writes are all gated, or that has none', () => {
    expect(
      checkProjectWriteRoles({
        apiVersion: '3.37.0',
        apiRoutes: { add: [add('PUT', '/cm/projects/:projectId/x')] },
      }).ok
    ).toBe(true)
    expect(checkProjectWriteRoles({ apiVersion: '3.37.0' })).toEqual({ ok: true, routes: [] })
  })
})
