// Story 72-20 probe: runs the real dashboard `load` in a plain Node process (default
// unhandled-rejection mode) against a fetch that answers 403 for the certificate and domain reads
// while the project dashboard read is slow. Run by dashboard-load-unhandled-rejection.test.ts.
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const WEB_ROOT = fileURLToPath(new URL('../apps/web/', import.meta.url))
// vite is a dependency of apps/web only, so resolve it from there.
const viteEntry = createRequire(`${WEB_ROOT}package.json`).resolve('vite')

const PROJECT_ID = randomUUID()
const SLOW_READ_MS = 200
const SETTLE_MS = 400

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

async function answer(path: string): Promise<Response> {
  if (path.endsWith('/certificates') || path.endsWith('/domains')) {
    return json(403, { code: 'insufficient_role', message: 'Insufficient role' })
  }
  if (path.endsWith('/dashboard')) {
    await new Promise((resolve) => setTimeout(resolve, SLOW_READ_MS))
    return json(200, { data: { upcomingRotations: [] } })
  }
  if (path.includes('/dashboard/attention')) {
    return json(200, {
      data: {
        items: [],
        counts: { expiringShares: 0, expiringCertificates: 0, pendingInvitations: 0 },
      },
    })
  }
  if (path.startsWith('/api/v1/projects')) {
    return json(200, {
      data: {
        items: [{ id: PROJECT_ID, name: 'Payments', description: null }],
        total: 1,
        page: 1,
        limit: 100,
        hasNext: false,
      },
    })
  }
  return json(404, { code: 'not_found', message: 'not found' })
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input
  return input instanceof URL ? input.href : input.url
}

const mockFetch = ((input: string | URL | Request) => {
  const raw = requestUrl(input)
  return answer(new URL(raw, 'http://localhost').pathname)
}) as typeof fetch

async function main(): Promise<void> {
  const { createServer } = (await import(pathToFileURL(viteEntry).href)) as typeof import('vite')
  const server = await createServer({
    root: WEB_ROOT,
    server: { middlewareMode: true },
    appType: 'custom',
    logLevel: 'error',
  })
  try {
    const page = (await server.ssrLoadModule('/src/routes/(app)/dashboard/+page.server.ts')) as {
      load: (event: unknown) => Promise<{ monitoringAssets: Record<string, Promise<unknown>> }>
    }
    const result = await page.load({
      fetch: mockFetch,
      url: new URL('http://localhost/dashboard'),
      locals: {},
      params: {},
      route: { id: '/(app)/dashboard' },
    })
    const states = await Promise.all([
      result.monitoringAssets.certificates,
      result.monitoringAssets.domains,
    ])
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))
    process.stdout.write(`${JSON.stringify(states)}\n`)
  } finally {
    await server.close()
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`)
  process.exitCode = 1
})
