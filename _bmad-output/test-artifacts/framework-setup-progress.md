---
stepsCompleted: ['step-01-preflight', 'step-02-select-framework', 'step-03-scaffold-framework', 'step-04-docs-and-scripts', 'step-05-validate-and-summary']
lastStep: 'step-05-validate-and-summary'
lastSaved: '2026-05-31'
mode: 'docs-only'
note: 'Planning artifact generated before codebase exists. No files created in application directories.'
---

# Test Framework Setup — Progress Log

## Step 1: Preflight

**Status:** Completed (docs-only mode)

| Check | Result | Notes |
|---|---|---|
| `test_stack_type` | `fullstack` (explicit config) | `_bmad/tea/config.yaml` |
| `package.json` present | ✗ Not found | Project is pre-implementation |
| Existing E2E framework | ✗ None | Clean state |
| Backend manifest | ✗ None | App not yet scaffolded |
| Architecture doc | ✅ Found | `_bmad-output/planning-artifacts/architecture.md` |
| TEA config | ✅ Found | `_bmad/tea/config.yaml` |

**Detected stack:** `fullstack`

**Blocker:** No `package.json` — project is in planning phase. Proceeding in docs-only mode.

---

## Step 2: Framework Selection

**Status:** Completed

### E2E / UI — Playwright

Config explicitly sets `test_framework: playwright`. This is the correct choice given:

- **Complex multi-domain app** — secrets vault with RBAC, multi-tenant views, real-time SSE feeds, rotation workflows
- **Multi-browser needed** — security-critical app benefits from Chrome + Firefox + WebKit coverage
- **Heavy API + UI integration** — Playwright's `request` fixture enables direct API seeding alongside UI flows
- **CI speed** — shard support and parallelism are important for the test suite volume expected from 95 FRs
- **Architecture alignment** — Turborepo task graph already planned; Playwright integrates as a top-level `turbo` task

Cypress would lose on multi-browser, parallelism, and API co-location — not competitive for this scope.

### Unit / Integration — Vitest

The architecture document explicitly selects **Vitest across all packages** ("unified runner, TypeScript-native, compatible with both SvelteKit and Node.js environments"). This is the unit/integration framework. Playwright handles only browser-level E2E.

### Contract Testing — Pact.js + `@seontechnologies/pactjs-utils`

Config has `tea_use_pactjs_utils: true`. `apps/web` (SvelteKit) is the **consumer**, `apps/api` (Fastify) is the **provider**. Consumer CDC tests validate that the web app's API client code matches the contract the API actually fulfills.

---

## Step 3: Framework Scaffold Design

**Status:** Completed (design only — no files written)

See `tests-README-plan.md` for the full specification.

### Directory Structure

```
project-vault/                              # Turborepo monorepo root
├── apps/
│   ├── web/
│   │   ├── tests/
│   │   │   ├── e2e/                        # Playwright E2E tests
│   │   │   │   ├── auth/
│   │   │   │   │   ├── login.spec.ts
│   │   │   │   │   └── mfa.spec.ts
│   │   │   │   ├── secrets/
│   │   │   │   │   ├── create-secret.spec.ts
│   │   │   │   │   ├── view-secret.spec.ts
│   │   │   │   │   └── rotation.spec.ts
│   │   │   │   └── rbac/
│   │   │   │       └── permission-gates.spec.ts
│   │   │   ├── contract/
│   │   │   │   ├── consumer/               # Pact consumer tests (.pacttest.ts)
│   │   │   │   │   ├── secrets-api.pacttest.ts
│   │   │   │   │   ├── auth-api.pacttest.ts
│   │   │   │   │   └── rotation-api.pacttest.ts
│   │   │   │   └── support/
│   │   │   │       ├── pact-config.ts      # PactV4 factory
│   │   │   │       ├── provider-states.ts  # Provider state factories
│   │   │   │       └── consumer-helpers.ts # Local shim (until pactjs-utils published)
│   │   │   └── support/
│   │   │       ├── fixtures/
│   │   │       │   ├── index.ts            # mergeTests composition
│   │   │       │   ├── auth.fixture.ts     # Session tokens, user roles
│   │   │       │   ├── api.fixture.ts      # API request + seeding
│   │   │       │   └── org.fixture.ts      # Org/tenant context
│   │   │       ├── helpers/
│   │   │       │   ├── auth.ts             # Login flows, MFA helpers
│   │   │       │   ├── secret.ts           # Secret CRUD helpers
│   │   │       │   └── network.ts          # SSE, network interception helpers
│   │   │       ├── factories/
│   │   │       │   ├── secret.factory.ts   # Fake secret data with overrides
│   │   │       │   ├── user.factory.ts     # User/role data
│   │   │       │   └── org.factory.ts      # Org/tenant data
│   │   │       └── page-objects/
│   │   │           ├── LoginPage.ts
│   │   │           ├── SecretsListPage.ts
│   │   │           └── SecretDetailPage.ts
│   │   ├── playwright.config.ts
│   │   └── vitest.config.pact.ts           # Dedicated pact vitest config
│   │
│   └── api/
│       └── src/
│           └── **/__tests__/              # Vitest unit/integration (per architecture)
│
├── scripts/                                # Pact broker shell scripts
│   ├── env-setup.sh
│   ├── publish-pact.sh
│   ├── can-i-deploy.sh
│   └── record-deployment.sh
│
├── .github/
│   ├── actions/
│   │   └── detect-breaking-change/
│   │       └── action.yml
│   └── workflows/
│       ├── contract-test-consumer.yml
│       └── e2e.yml                         # (existing CI or new)
│
└── .env.example                            # TEST_ENV, BASE_URL, API_URL
```

### Key Design Decisions

**Monorepo placement:** E2E and contract tests live in `apps/web/` because they test the web consumer. They are not at monorepo root to avoid Turborepo task graph complications; Playwright and pact vitest configs are scoped to the web app package.

**Vitest for unit tests:** Each package (`packages/db`, `packages/crypto`, `packages/shared`, `apps/api`) maintains its own Vitest config and `__tests__/` directories per the architecture document. The `turbo.json` task graph runs these in parallel.

**Playwright config scope:** `playwright.config.ts` lives in `apps/web/` and is invoked via `pnpm --filter web test:e2e` or `turbo run test:e2e`.

**Pact vitest config:** Separate `vitest.config.pact.ts` in `apps/web/` — minimal config, no settings inherited from unit test config.

### Framework Config Spec

#### `apps/web/playwright.config.ts`

```typescript
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 4 : undefined,

  use: {
    baseURL: process.env.BASE_URL ?? 'http://localhost:5173',
    trace: 'retain-on-failure-and-retries',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },

  timeout: 60_000,

  reporter: [
    ['html', { outputFolder: '../../_bmad-output/test-artifacts/playwright-report' }],
    ['junit', { outputFile: '../../_bmad-output/test-artifacts/junit-results.xml' }],
    ['list'],
  ],

  projects: [
    { name: 'setup', testMatch: '**/auth.setup.ts' },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      dependencies: ['setup'],
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
      dependencies: ['setup'],
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
      dependencies: ['setup'],
    },
  ],

  webServer: {
    command: 'pnpm dev',
    url: process.env.BASE_URL ?? 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
```

#### `apps/web/vitest.config.pact.ts`

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/contract/**/*.pacttest.ts'],
    testTimeout: 30_000,
  },
});
```

### Fixtures Design

**Fixture composition** via `mergeTests` from `@playwright/test`:

```typescript
// apps/web/tests/support/fixtures/index.ts
import { mergeTests } from '@playwright/test';
import { test as apiRequestFixture } from '@seontechnologies/playwright-utils/api-request/fixtures';
import { test as authFixture } from '@seontechnologies/playwright-utils/auth-session/fixtures';
import { test as recurseFixture } from '@seontechnologies/playwright-utils/recurse/fixtures';
import { test as logFixture } from '@seontechnologies/playwright-utils/log/fixtures';
import { test as networkMonitorFixture } from '@seontechnologies/playwright-utils/network-error-monitor/fixtures';
import { test as interceptFixture } from '@seontechnologies/playwright-utils/intercept-network-call/fixtures';

// Project-specific fixtures
import { orgFixture } from './org.fixture';

export const test = mergeTests(
  apiRequestFixture,
  authFixture,
  recurseFixture,
  logFixture,
  networkMonitorFixture,
  interceptFixture,
  orgFixture,
);

export { expect } from '@playwright/test';
```

**Auth fixture** — multi-role session persistence (critical for RBAC-heavy app):

```typescript
// apps/web/tests/support/fixtures/auth.fixture.ts
// Saves auth state per role to avoid repeated login flows in every test.
// Storage state files live in tests/support/.auth/ (gitignored).
```

**Data factories** — Faker-based with override support:

```typescript
// apps/web/tests/support/factories/secret.factory.ts
import { faker } from '@faker-js/faker';

export type SecretOverrides = { name?: string; value?: string; projectId?: string };

export const buildSecret = (overrides: SecretOverrides = {}) => ({
  name: overrides.name ?? faker.internet.domainWord(),
  value: overrides.value ?? faker.internet.password({ length: 32 }),
  projectId: overrides.projectId ?? faker.string.uuid(),
  description: faker.lorem.sentence(),
});
```

### Pact Config Spec

**Consumer name:** `project-vault-web`
**Provider name:** `project-vault-api`
**Pact output dir:** `pacts/` (gitignored at `apps/web/pacts/`)

```typescript
// apps/web/tests/contract/support/pact-config.ts
import path from 'node:path';
import { PactV4 } from '@pact-foundation/pact';

export const createPact = (overrides?: { consumer?: string; provider?: string }) =>
  new PactV4({
    dir: path.resolve(process.cwd(), 'pacts'),
    consumer: overrides?.consumer ?? 'project-vault-web',
    provider: overrides?.provider ?? 'project-vault-api',
    logLevel: 'warn',
  });
```

### Environment Variables

```bash
# .env.example (at apps/web/ or monorepo root)
TEST_ENV=local
BASE_URL=http://localhost:5173
API_URL=http://localhost:3000

# Pact broker (CI only)
PACT_BROKER_BASE_URL=
PACT_BROKER_TOKEN=
```

```
# .nvmrc
24
```

---

## Step 4: Documentation & Scripts Design

**Status:** Completed (design only)

See `tests-README-plan.md` for the full README content.

### package.json Scripts (for `apps/web/package.json`)

```json
{
  "scripts": {
    "test:e2e": "playwright test",
    "test:e2e:ui": "playwright test --ui",
    "test:e2e:headed": "playwright test --headed",
    "test:e2e:debug": "playwright test --debug",
    "test:pact:consumer": "vitest run --config vitest.config.pact.ts",
    "publish:pact": ". ./scripts/env-setup.sh && ./scripts/publish-pact.sh",
    "can:i:deploy:consumer": ". ./scripts/env-setup.sh && PACTICIPANT=project-vault-web ./scripts/can-i-deploy.sh",
    "record:consumer:deployment": ". ./scripts/env-setup.sh && PACTICIPANT=project-vault-web ./scripts/record-deployment.sh"
  }
}
```

### `turbo.json` additions

```json
{
  "tasks": {
    "test:e2e": {
      "dependsOn": ["^build"],
      "outputs": ["playwright-report/**", "junit-results.xml"],
      "cache": false
    },
    "test:pact:consumer": {
      "outputs": ["pacts/**"],
      "cache": false
    }
  }
}
```

---

## Step 5: Validation

**Status:** Completed

### Checklist

**Preflight**
- [x] Stack detected: `fullstack`
- [x] TEA config confirmed: Playwright + Pact.js + GitHub Actions
- [x] No conflicting framework found
- [x] Architecture doc read and stack context gathered

**Framework Selection**
- [x] Playwright selected for E2E (config-explicit + correct fit for project complexity)
- [x] Vitest confirmed for unit/integration (per architecture doc)
- [x] Pact.js selected for contract testing (config-explicit)

**Directory Structure**
- [x] E2E: `apps/web/tests/e2e/` with domain-organized specs
- [x] Contract consumer: `apps/web/tests/contract/consumer/` (`.pacttest.ts` extension)
- [x] Contract support: `apps/web/tests/contract/support/`
- [x] Fixtures: `apps/web/tests/support/fixtures/` with `mergeTests` composition
- [x] Factories: `apps/web/tests/support/factories/` with Faker + overrides
- [x] Page objects: `apps/web/tests/support/page-objects/`
- [x] Shell scripts: `scripts/` at monorepo root

**Config**
- [x] `playwright.config.ts` — timeouts, artifacts, 3 browsers, `retain-on-failure-and-retries`
- [x] `vitest.config.pact.ts` — minimal, 30s timeout, no copied settings
- [x] `.env.example` — `TEST_ENV`, `BASE_URL`, `API_URL`
- [x] `.nvmrc` — Node 24

**Fixtures & Factories**
- [x] `mergeTests` composition fixture index
- [x] Multi-role auth fixture (RBAC critical)
- [x] Faker data factories with override pattern
- [x] Org/tenant context fixture (multi-tenant app)

**Pact**
- [x] Pact config factory with correct consumer/provider names
- [x] Provider state factory pattern
- [x] Local consumer-helpers shim specified
- [x] Script names match pactjs-utils convention
- [x] Shell scripts with correct `set -eu`/`set -euo pipefail` discipline
- [x] `detect-breaking-change` composite action specified
- [x] CI workflow (`contract-test-consumer.yml`) with workflow-level env block

**Scripts & CI**
- [x] `package.json` scripts for E2E, pact consumer, broker operations
- [x] `turbo.json` task additions
- [x] CI workflow structure specified

**Gaps / Notes for Implementation**
- [ ] `@seontechnologies/playwright-utils` requires install after `pnpm install`
- [ ] `@seontechnologies/pactjs-utils` may not yet be published — use local shim from this doc
- [ ] Auth setup spec (`tests/support/fixtures/auth.setup.ts`) needs actual app routes to implement
- [ ] Pact provider verification workflow (`contract-test-provider.yml`) needed on API side — out of scope for this consumer setup
- [ ] Pact broker URL/token secrets must be added to GitHub repo settings before CI can run

---

## Knowledge Fragments Applied

| Fragment | Applied To |
|---|---|
| `overview.md` | `@seontechnologies/playwright-utils` fixture composition patterns |
| `fixtures-composition.md` | `mergeTests` index structure |
| `auth-session.md` | Multi-role auth fixture design |
| `api-request.md` | API fixture for seeding and direct API tests |
| `recurse.md` | Polling fixture for background job assertions |
| `network-error-monitor.md` | Automatic HTTP error detection in UI tests |
| `intercept-network-call.md` | SSE and network spy patterns |
| `data-factories.md` | Faker-based factory with overrides pattern |
| `pact-consumer-framework-setup.md` | Full Pact directory, scripts, CI, config design |
| `pactjs-utils-overview.md` | Library selection and URL injection patterns |
