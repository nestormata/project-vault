import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClientError } from '$lib/api/client.js'

// Story 69.7 AC-2 / AC-4 / AC-12 (DW-531): every page that answers a caller PV denied with a literal
// `allowed: false` runs NO contribution load for that caller. The inventory below is the single list;
// the self-wiring test at the bottom fails when a page/layout server file returns `allowed: false`
// and is not in it, so a new denial page cannot ship without a skip test.

const spies = vi.hoisted(() => ({ contribution: vi.fn(), getProject: vi.fn() }))

const PAGES = [
  ['(app)/settings/audit', '/(app)/settings/audit'],
  ['(app)/settings/audit/access-report', '/(app)/settings/audit/access-report'],
  ['(app)/settings/audit/forwarding', '/(app)/settings/audit/forwarding'],
  ['(app)/settings/sso-domains', '/(app)/settings/sso-domains'],
  ['(app)/settings/extensions', '/(app)/settings/extensions'],
  ['(app)/settings/external-identities', '/(app)/settings/external-identities'],
  ['(app)/platform', '/(app)/platform'],
  ['(app)/platform/audit', '/(app)/platform/audit'],
  ['(app)/platform/backups', '/(app)/platform/backups'],
  ['(app)/platform/upgrade', '/(app)/platform/upgrade'],
  ['(app)/platform/settings', '/(app)/platform/settings'],
  ['(app)/platform/settings/orgs', '/(app)/platform/settings/orgs'],
  ['(app)/platform/settings/resource-usage', '/(app)/platform/settings/resource-usage'],
] as const

vi.mock('virtual:pv-inject-behavior', () => {
  const ids = [
    '/(app)/settings/audit',
    '/(app)/settings/audit/access-report',
    '/(app)/settings/audit/forwarding',
    '/(app)/settings/sso-domains',
    '/(app)/settings/extensions',
    '/(app)/settings/external-identities',
    '/(app)/platform',
    '/(app)/platform/audit',
    '/(app)/platform/backups',
    '/(app)/platform/upgrade',
    '/(app)/platform/settings',
    '/(app)/platform/settings/orgs',
    '/(app)/platform/settings/resource-usage',
    '/(app)/projects/[projectId]',
  ]
  const point = { point: 'p', contributions: [{ order: 0, load: spies.contribution }] }
  const loads: Record<string, unknown[]> = {}
  for (const id of ids) {
    loads[`${id}#page`] = [point]
    loads[`${id}#layout`] = [point]
  }
  return { loads, actions: {} }
})
vi.mock('$lib/api/projects.js', () => ({
  getProject: spies.getProject,
  getProjectDashboard: vi.fn(),
}))

type AnyLoad = (event: never) => Promise<Record<string, unknown>>

function deniedEvent() {
  return {
    fetch: async () => new Response('{}', { status: 200 }),
    url: new URL('http://localhost/x'),
    params: { projectId: 'p-1' },
    locals: {
      user: { userId: 'u-1', orgRole: 'viewer', isPlatformOperator: false, mfaEnrolled: true },
    },
  } as never
}

beforeEach(() => {
  spies.contribution.mockReset()
  spies.getProject.mockReset()
})

describe('AC-2: a denied caller runs no contribution load on any allowed:false page', () => {
  it.each(PAGES)('%s', async (dir) => {
    const mod = (await import(/* @vite-ignore */ `./${dir}/+page.server.ts`)) as {
      load: AnyLoad
    }
    const data = await mod.load(deniedEvent())
    expect(data['allowed']).toBe(false)
    expect(spies.contribution).not.toHaveBeenCalled()
    expect(data['__inject']).toEqual({ p: [null] })
  })
})

describe('AC-4: a PV 404 on the project page and layout runs no contribution load', () => {
  it('page and layout', async () => {
    spies.getProject.mockRejectedValue(new ApiClientError(404, null, 'not found'))
    const page = (await import('./(app)/projects/[projectId]/+page.server.js')) as {
      load: AnyLoad
    }
    const layout = (await import('./(app)/projects/[projectId]/+layout.server.js')) as {
      load: AnyLoad
    }
    expect((await page.load(deniedEvent()))['notFound']).toBe(true)
    expect((await layout.load(deniedEvent()))['notFound']).toBe(true)
    expect(spies.contribution).not.toHaveBeenCalled()
  })
})

function serverFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return serverFiles(path)
    return /\+(page|layout)\.server\.ts$/.test(entry.name) ? [path] : []
  })
}

describe('AC-12: the inventory covers every page that returns allowed:false', () => {
  it('has no page/layout server file returning allowed:false outside the inventory', () => {
    const routes = join(process.cwd(), 'src/routes')
    const covered = new Set(PAGES.map(([dir]) => `${dir}/+page.server.ts`))
    const uncovered = serverFiles(routes)
      .filter((file) => /allowed:\s*false\b/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(routes, file).split('\\').join('/'))
      .filter((file) => !covered.has(file))
    expect(uncovered).toEqual([])
  })

  it('lists only files that exist and really return allowed:false', () => {
    const routes = join(process.cwd(), 'src/routes')
    for (const [dir] of PAGES) {
      const source = readFileSync(join(routes, dir, '+page.server.ts'), 'utf8')
      expect(source, dir).toMatch(/allowed:\s*false\b/)
    }
  })
})
