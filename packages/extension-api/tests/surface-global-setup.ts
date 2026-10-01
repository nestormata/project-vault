import { fileURLToPath } from 'node:url'
import type { TestProject } from 'vitest/node'
import { provideSurfaceGeneration, type SettledSurface } from './surface-runner.js'

declare module 'vitest' {
  export interface ProvidedContext {
    apiSurfaceGeneration: SettledSurface
  }
}

/*
 * Story 66-6: vitest globalSetup for the package test task. It runs the single public-surface
 * generation (one uninstrumented child process, see surface-runner.ts) once per vitest run,
 * before any test worker starts, and provides the settled outcome to src/api-surface.test.ts.
 * The child's cost (~0.6 s alone, ~4-6 s under nightly's 4-vCPU contention) is therefore paid
 * outside every test's 15 s window, and never overlaps the package's own coverage workers.
 *
 * It never throws: a failed generation is provided as data and fails the dependent tests with
 * its full message. Nothing is cached on disk; every `vitest run` (turbo `--force`, the nightly
 * 5x loop) regenerates, and so does every watch-mode rerun (`onTestsRerun`). Contexts without this config (the
 * repo-root `pnpm vitest run packages/extension-api/src/api-surface.test.ts` in ci.yml Checks)
 * get nothing provided and generate lazily inside the test instead.
 */
export default function setup(project: TestProject): void {
  provideSurfaceGeneration(project, fileURLToPath(new URL('..', import.meta.url)))
}
