import { defineConfig, devices } from '@playwright/test'

// Story 68.10 AC-2.6: the mechanism e2e (M1-M7 together, composed image, real API and database).
// Its own config, never the shared `playwright.config.ts` (whose testDir runs j1-j31 and whose
// `retries: 1` and `trace` / `video: retain-on-failure` are deliberately NOT copied here):
//
//   - retries 0: the stack is deterministic, a retry would hide a flake the mutation proofs must see;
//   - trace, video and screenshot OFF: a trace or screenshot of a logged-in page can carry a session
//     cookie, and the failure artifact of this job is the HTML report only;
//   - forbidOnly always on, one worker (every spec seeds its own orgs and users, but the shared
//     stack keeps one rate-limit window);
//   - the output directory is named `playwright-mechanism-output` on purpose: the repo `.gitignore`
//     hides any directory named `reports/` or `coverage/` from git and CI.
//
// E2E_BASE_URL (the composed web origin) and E2E_API_BASE_URL (the API port, for the routes outside
// /api/v1 the web origin does not proxy) come from the runner (`scripts/mock-ui-pack-e2e.ts`) and
// are required: there is no default, so this config can never point at another stack by accident.
const ENVIRONMENT = new Map(Object.entries(process.env))
function required(name: string): string {
  const value = ENVIRONMENT.get(name)
  if (value === undefined || value === '') {
    throw new Error(`${name} is required: run the mechanism e2e through \`make mock-ui-pack-e2e\``)
  }
  return value
}

export default defineConfig({
  testDir: './e2e/mechanism',
  testMatch: '**/*.spec.ts',
  globalSetup: './e2e/mechanism/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [
    ['html', { open: 'never' as const, outputFolder: './playwright-mechanism-output/html' }],
    ['list'],
  ],
  outputDir: './playwright-mechanism-output/artifacts',
  use: {
    baseURL: required('E2E_BASE_URL'),
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
