import { defineConfig, devices } from '@playwright/test'

// AC-I1: v1 deliberately targets Chromium only — fewer moving parts for the first suite;
// Firefox/WebKit are a natural follow-up once the 4 journeys are stable (see Dev Notes).
//
// baseURL/WEB_HOST_PORT: the web app is a thin server-side proxy for every /api/v1/* request
// (apps/web/src/routes/api/v1/[...path]/+server.ts), so Playwright only ever needs ONE origin —
// the web app's own — matching this repo's AGENTS.md "Docker port isolation" convention where
// WEB_HOST_PORT may have been bumped by `make fix-ports` away from the 5173 default.
const webHostPort = process.env['WEB_HOST_PORT'] ?? '5173'
const baseURL = process.env['E2E_BASE_URL'] ?? `http://localhost:${webHostPort}`

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/journeys/*.spec.ts',
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  // AC-I3: workers: 1 / fullyParallel: false is the deliberate trade-off that makes per-test
  // unique-org/user data isolation safe against a single shared DB without inter-test locking.
  fullyParallel: false,
  workers: 1,
  retries: process.env['CI'] ? 1 : 0,
  forbidOnly: Boolean(process.env['CI']),
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  reporter: [
    ['html', { open: 'never' as const, outputFolder: './e2e/test-results/html' }],
    ['list'],
  ],
  outputDir: './e2e/test-results/artifacts',
  use: {
    baseURL,
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
})
