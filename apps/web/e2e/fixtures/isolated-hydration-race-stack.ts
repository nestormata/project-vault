import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  REPO_ROOT,
  spawnIsolatedApiProcess,
  spawnIsolatedWebProcess,
  waitForHttp,
  type WebHandle,
} from './isolated-stack-shared.js'

// Story 28.3 (AC1) — a self-contained, isolated API+web process pair for j26's own hydration-
// race reproduction journey. Deliberately NOT sharing the main E2E docker stack: this journey
// needs to run the SAME web app twice, once under Vite dev (`spawnIsolatedWebProcess`, already
// generic/shared) and once as a real production-style build (`@sveltejs/adapter-node`'s
// `build/index.js`, matching exactly how `apps/web/Dockerfile`/`make docker-up` serve it) — the
// shared stack only ever runs one of those two modes at a time.

export type ApiHandle = { process: ChildProcess; port: number; dbName: string; webPort: number }

/** Boots a plain (no extension) isolated `apps/api` process — this journey's subject under test
 * is entirely client-side hydration timing, so the API side needs nothing special. */
export async function startHydrationRaceApi(options: {
  port: number
  dbName: string
  webPort: number
}): Promise<ApiHandle> {
  const child = await spawnIsolatedApiProcess({
    port: options.port,
    dbName: options.dbName,
    webPort: options.webPort,
    logLabel: 'api-hydration-race',
    logLevelEnvVar: 'J26_DEBUG_LOG_LEVEL',
  })
  return { process: child, port: options.port, dbName: options.dbName, webPort: options.webPort }
}

/** Vite dev mode — reuses the generic isolated-web spawner unchanged (matches J19/J20's
 * documented environment: an unbundled, 200+-request module graph). */
export async function startHydrationRaceWebDev(options: {
  port: number
  apiPort: number
}): Promise<WebHandle> {
  return spawnIsolatedWebProcess({
    port: options.port,
    apiPort: options.apiPort,
    logLabel: 'web-hydration-race-dev',
  })
}

/**
 * Builds `apps/web` (and its two workspace deps whose compiled `dist/` it imports at build time)
 * exactly once per test run — real `vite build` + `@sveltejs/adapter-node`, not a mock. Mirrors
 * `apps/web/Dockerfile`'s builder stage's own build order (shared, extension-api, then web)
 * without the Docker layer itself, since this journey only needs the build OUTPUT
 * (`apps/web/build/`), not a container image.
 */
export function buildHydrationRaceWeb(): void {
  const env = { ...process.env }
  execFileSync('pnpm', ['--filter', '@project-vault/shared', 'build'], {
    cwd: REPO_ROOT,
    env,
    stdio: 'inherit',
  })
  execFileSync('pnpm', ['--filter', '@project-vault/extension-api', 'build'], {
    cwd: REPO_ROOT,
    env,
    stdio: 'inherit',
  })
  execFileSync('pnpm', ['--filter', '@project-vault/web', 'build'], {
    cwd: REPO_ROOT,
    env,
    stdio: 'inherit',
  })
}

function pipeDiagnostics(child: ChildProcess, label: string, port: number): void {
  // eslint-disable-next-line no-console -- diagnostic aid when this journey fails locally
  child.stdout?.on('data', (chunk) => console.log(`[${label}:${port}]`, String(chunk)))
  child.stderr?.on('data', (chunk) => {
    // eslint-disable-next-line no-console -- diagnostic aid when this journey fails locally
    console.error(`[${label}:${port}]`, String(chunk))
  })
}

/** Serves the already-built `apps/web/build/index.js` (adapter-node) — a real production-style
 * process, same entrypoint `apps/web/Dockerfile`'s runtime stage runs (`CMD ["node", "build"]`),
 * just started directly instead of inside a container. Caller must have already called
 * `buildHydrationRaceWeb()` at least once this run. */
export async function startHydrationRaceWebBuild(options: {
  port: number
  apiPort: number
}): Promise<WebHandle> {
  const buildEntry = fileURLToPath(new URL('../../build/index.js', import.meta.url))
  const child = spawn(process.execPath, [buildEntry], {
    cwd: `${REPO_ROOT}/apps/web`,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(options.port),
      HOST: '0.0.0.0',
      // adapter-node refuses cross-site POST form submissions without a configured ORIGIN — same
      // convention as docker-compose.yml's own ORIGIN=http://localhost:${WEB_HOST_PORT}.
      ORIGIN: `http://localhost:${options.port}`,
      API_BASE_URL: `http://localhost:${options.apiPort}`,
    },
    stdio: 'pipe',
    detached: true,
  })
  pipeDiagnostics(child, 'web-hydration-race-build', options.port)

  await waitForHttp(`http://localhost:${options.port}/login`)
  return { process: child, port: options.port }
}
