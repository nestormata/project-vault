# Story 2.0: MVP Frontend Shell & Empty Project Dashboard

Status: ready-for-dev

<!-- Ultimate context engine analysis completed 2026-06-27 - comprehensive developer guide for the first real SvelteKit frontend shell. This story intentionally validates the vault/auth/project mental model before durable project and credential APIs exist. It consumes real Epic 1 vault/auth APIs, renders honest empty states, and prepares the screen/data contracts for Story 2.1 without creating fake operational data. -->

## Story

As a first-time evaluator,
I want to initialize or unseal the vault, register or log in, and land in a project-centered app shell,
so that I understand Project Vault's core product model before the full credential-management feature set exists.

*Covers: FR46. Supports early validation of FR1, FR7, FR8, FR53, FR60, FR72, FR93, and FR98 without shipping credential, alert, health, rotation, machine-user, audit, or monitoring functionality.* [Source: `_bmad-output/planning-artifacts/epics.md#Story-2.0-MVP-Frontend-Shell--Empty-Project-Dashboard`]

---

## Prerequisites

| Prerequisite | Why |
|---|---|
| Epic 1 auth APIs are available and stable enough for frontend wiring | Story 2.0 uses `POST /api/v1/auth/register`, `POST /api/v1/auth/login`, `POST /api/v1/auth/refresh`, `POST /api/v1/auth/logout`, and `GET /api/v1/auth/me`. |
| Epic 1 vault APIs are available | Story 2.0 uses `GET /ready`, `POST /api/v1/vault/init`, and `POST /api/v1/vault/unseal`. |
| Story 1.12 status is checked before implementation | If 1.12 is complete, login must handle `{ data: { mfaRequired: true, mfaToken } }` plus verify-login. If 1.12 is not complete, MFA login UI is explicitly deferred and documented as blocked by 1.12. |
| No `projects` table exists yet | `packages/db/src/schema/audit-log-entries.ts` states the FK to `projects(id)` is deferred to Story 2.1. Do not invent durable project persistence in 2.0 unless the team explicitly re-scopes the story. |
| Existing web app is a minimal scaffold | `apps/web/src/routes/+page.svelte` currently renders only the product name and tagline; `apps/web/src/routes/page.test.ts` is a placeholder. This story establishes the first real frontend structure. |

### Selected Implementation Path for "Create Project"

Use the **fallback preview stub** path from the epic, not the preferred real API path.

Reason: Story 2.1 owns the `projects` table, project RLS, `POST /api/v1/projects`, `GET /api/v1/projects`, and `GET /api/v1/projects/:projectId/dashboard`. Implementing those durably in 2.0 would split Story 2.1 and increase security/RLS risk. Story 2.0 may include a "Preview project dashboard" action, but it must be explicitly labeled as temporary, non-persistent, and reset-on-reload.

Required copy near any preview action:

```text
Preview only. Project persistence arrives in Story 2.1. This preview resets when you reload.
```

Do not call it "Create project" unless the UI also states in the same viewport that the project is not saved.

---

## Epic Cross-Story Context

| Story | Relationship to 2.0 |
|---|---|
| 1.3 | Provides `/health` and `/ready`. `GET /ready` is the frontend's first vault/readiness probe. |
| 1.5 | Provides vault init/unseal behavior and host trust-boundary constraints. The frontend must never leak key paths, passphrases, or submitted unseal material into storage or logs. |
| 1.6 | Provides registration, login, refresh, logout, and cookie session behavior. Frontend must rely on HttpOnly cookies only. |
| 1.7 | Provides session refresh/revocation behavior. SvelteKit server-side hooks must refresh transparently and handle revoked/expired sessions calmly. |
| 1.8 | Provides MFA enrollment state returned by `GET /auth/me`; 2.0 can show an MFA enrollment-required banner if present, but does not implement enrollment screens unless already present and stable. |
| 1.9 | Adds MFA enforcement status in `GET /auth/me`. 2.0 must not bypass or hide enforcement banners from authenticated users. |
| 1.10 | Structured operational logging exists on the API. Frontend must not log secret material, key paths, passphrases, auth request bodies, or credential-like values. |
| 1.11 | SecureRoute framework may affect auth exemptions. 2.0 should consume the published API behavior, not refactor API routes. |
| 1.12 | If complete, login may return `mfaRequired`; 2.0 consumes that contract. If incomplete, the MFA login step is blocked and documented. |
| 2.1 | Owns durable project creation, project list, project dashboard API, empty project response shape, and project RLS. 2.0 must shape placeholders so 2.1 can replace preview/stub state without redesign. |

---

## Architecture Conflict Resolution (Read Before Coding)

| Source wording | Canonical implementation for 2.0 | Rationale |
|---|---|---|
| Epic says `GET /ready` distinguishes uninitialized, sealed, unavailable, ready | Current API returns `503 { status: "unavailable", reason: "sealed" }` for both uninitialized and sealed, with different messages | Frontend can classify uninitialized vs sealed by message today, but this is brittle. Preferred 2.0 small backend improvement: change `/ready` uninitialized reason to `uninitialized` while preserving existing sealed behavior. Add tests if changed. |
| Epic says init/unseal forms accept the key file path required by the API | Current API supports three init modes: `passphrase`, `envelope`, `file`; unseal accepts exactly one of `passphrase`, `envelopeKeyPath`, `masterKeyPath` | UI must support passphrase and file/envelope path inputs according to the API schema, while copy emphasizes host trust boundaries. Do not force file path for passphrase mode. |
| Architecture says browser sessions use HttpOnly cookies only | Frontend should never read or store tokens | Use `credentials: 'include'` on client and SSR fetches. Never use localStorage/sessionStorage/IndexedDB for access, refresh, MFA, or vault material. |
| Epic permits a local preview project stub | Selected path: preview stub only, reset-on-reload | No durable `projects` table exists. The preview state must not look persisted. |
| Dashboard wants "green silence" | 2.0 has no real health/alert/credential sources | Do **not** show green/healthy/success operational state. Use empty/not-configured states only. |
| Navigation includes unavailable sections | Routes may exist, but must be honest placeholders | `Credentials`, `Alerts`, `Health`, and `Settings` may render explanatory empty/coming states, not fake data or 404s. |
| Story 1.12 may not be done | Current sprint status has 1.12 ready-for-dev, not done | Implement MFA login only if backend 1.12 has landed. Otherwise include blocked implementation note and tests must assert the non-MFA login path only. |

---

## Acceptance Criteria

### AC Quick Reference

| Area | Required result |
|---|---|
| Vault readiness | Distinct uninitialized, sealed, unavailable, and ready UI states; only valid next action visible. |
| Vault init/unseal | Explicit operator forms, host trust-boundary copy, no echo/log/storage of submitted passphrase/path after submit. |
| Auth | Register/login/refresh/logout/me use Epic 1 APIs and HttpOnly cookies only. |
| Route guard | Server-side SvelteKit guard redirects unauthenticated users and refreshes valid sessions transparently. |
| MFA login | Implement only if Story 1.12 backend exists; otherwise document blocked state. |
| App shell | Responsive authenticated layout with Dashboard, Projects, Credentials, Alerts, Health, Settings. |
| Dashboard | Project-centered empty state, no fake metrics, Story 2.1 payload shape mirrored in typed placeholders. |
| Preview project | Preview-only, non-persistent, reset-on-reload, visibly labeled. |
| Mobile | No horizontal scroll for primary vault/auth/dashboard flows at common phone widths. |
| Tests | Focused frontend tests for state rendering, auth paths, guards, logout, honest placeholders, and mobile smoke. |

---

### AC-1: File Layout and Route Structure

**Given** the web app currently contains only `+page.svelte`, `+layout.svelte`, `app.css`, `app.html`, and a placeholder test,
**When** Story 2.0 is complete,
**Then** establish this SvelteKit file structure:

```text
apps/web/src/
├── hooks.server.ts                         # NEW: auth/refresh route guard and locals population
├── app.d.ts                                # NEW or MODIFY: App.Locals auth shape
├── lib/
│   ├── api/
│   │   ├── client.ts                       # NEW: typed fetch wrapper, credentials include
│   │   ├── auth.ts                         # NEW: register/login/logout/me/refresh helpers
│   │   ├── vault.ts                        # NEW: ready/init/unseal helpers
│   │   └── dashboard-preview.ts            # NEW: Story 2.1-shaped placeholder payloads
│   ├── components/
│   │   ├── auth/
│   │   │   ├── LoginForm.svelte
│   │   │   ├── RegisterForm.svelte
│   │   │   └── MfaLoginForm.svelte         # only active if Story 1.12 backend exists
│   │   ├── vault/
│   │   │   ├── VaultGate.svelte
│   │   │   ├── VaultInitForm.svelte
│   │   │   └── VaultUnsealForm.svelte
│   │   ├── shell/
│   │   │   ├── AppShell.svelte
│   │   │   ├── PrimaryNav.svelte
│   │   │   └── PlaceholderSection.svelte
│   │   └── dashboard/
│   │       ├── CrossProjectEmptyState.svelte
│   │       ├── ProjectDashboardEmptyState.svelte
│   │       └── DashboardPlaceholderGrid.svelte
│   └── state/
│       └── preview-project.svelte.ts       # NEW: module-level $state, reset-on-reload only
└── routes/
    ├── +layout.svelte
    ├── +page.server.ts                     # NEW: redirect root by vault/auth state
    ├── (auth)/
    │   ├── +layout.svelte
    │   ├── login/+page.svelte
    │   └── register/+page.svelte
    ├── (vault)/
    │   └── vault/+page.svelte              # init/unseal/operator state
    └── (app)/
        ├── +layout.server.ts               # requires auth
        ├── +layout.svelte                  # shell navigation
        ├── dashboard/+page.svelte
        ├── projects/+page.svelte
        ├── projects/preview/+page.svelte   # preview-only route, if implemented
        ├── credentials/+page.svelte
        ├── alerts/+page.svelte
        ├── health/+page.svelte
        └── settings/+page.svelte
```

**And** all route groups use SvelteKit file-based routing exactly as architecture specifies: `(auth)` for unauthenticated routes, `(app)` for authenticated routes, and project-scoped routes later under `(app)/projects/[projectId]/`. [Source: `_bmad-output/planning-artifacts/architecture.md#Frontend-Architecture`]

**And** do not introduce a frontend state library; use Svelte 5 runes and module-level state where shared client state is needed. [Source: `_bmad-output/planning-artifacts/architecture.md#Frontend-Architecture`]

**And** keep `apps/web/src/lib/components/ui/` reserved for shadcn-svelte primitives if components are added later; do not place feature components there.

---

### AC-2: API Client Boundary

**Given** the frontend must call same-origin or configured API endpoints with cookie credentials,
**When** API helpers are added,
**Then** create a single fetch boundary that all UI flows use.

Example shape:

```typescript
type ApiSuccess<T> = { data: T }
type ApiFailure = { code?: string; error?: string; message: string; details?: unknown }

export async function apiFetch<T>(
  fetchFn: typeof fetch,
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const response = await fetchFn(path, {
    ...init,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...init.headers,
    },
  })

  if (response.status === 204) return undefined as T

  const body = (await response.json().catch(() => null)) as ApiSuccess<T> | ApiFailure | null
  if (!response.ok) {
    const message = body && 'message' in body ? body.message : 'Request failed'
    throw new ApiClientError(response.status, body, message)
  }

  return body && 'data' in body ? body.data : (body as T)
}
```

**And** every browser-side request to authenticated endpoints uses `credentials: 'include'`.

**And** SvelteKit server-side `event.fetch` calls that depend on cookies must explicitly forward relevant cookies when calling the API from hooks/server load if the API origin differs from the web origin. If same-origin proxying is used, document that choice in code comments.

**And** no UI component calls `fetch` directly except through `lib/api/*` helpers.

**And** normalize backend error shapes:

| Backend shape | Example | Frontend handling |
|---|---|---|
| `{ code, message }` | auth errors | Show user-safe `message`; branch on `code` only when needed. |
| `{ error, message }` | vault/readiness errors | Show user-safe `message`; branch on `error` or status. |
| `204 No Content` | logout | Treat as success with no body. |

---

### AC-3: Vault Readiness Gate

**Given** a user opens the web app before using any authenticated routes,
**When** the app calls `GET /ready`,
**Then** the frontend renders one of exactly four states:

| State | API signal | UI result | Allowed primary action |
|---|---|---|---|
| Uninitialized | `503`, body indicates not initialized | Shows "Initialize vault" operator flow | Initialize |
| Sealed | `503`, body indicates manual unseal required | Shows "Unseal vault" operator flow | Unseal |
| Unavailable | network error or `503 { reason: "db" }` | Shows retry-safe unavailable state | Retry readiness |
| Ready | `200 { status: "ready" }` | Allows auth routes/app shell | Continue |

**Current backend caveat:** `GET /ready` currently returns `reason: "sealed"` for both uninitialized and sealed, with different `message` values. Preferred fix inside 2.0: update `apps/api/src/routes/health.ts` so the uninitialized branch returns:

```json
{
  "status": "unavailable",
  "reason": "uninitialized",
  "message": "Vault not initialized. POST /api/v1/vault/init to initialize."
}
```

If this small backend fix is made, add/adjust API tests for both uninitialized and sealed readiness bodies. If not made, the frontend must classify by message and include an implementation note pointing to this API ambiguity; do not silently treat both as the same state.

**And** only the valid next action is visible:

- Uninitialized: show init form; do not show login/register/app nav.
- Sealed: show unseal form; do not show init/register/login/app nav.
- Unavailable: show retry and diagnostic copy; do not show init/unseal unless state is known.
- Ready: show auth or app shell according to session state.

**And** `GET /health` may be used only as a diagnostic fallback; it does not mean the vault is usable.

---

### AC-4: Vault Init Form

**Given** the vault is uninitialized,
**When** the user opens the vault operator flow,
**Then** the UI supports the API's three init modes:

| Mode | Request body | Required UI copy |
|---|---|---|
| Passphrase | `{ "kmsType": "passphrase", "passphrase": "..." }` | "The vault key is derived from this passphrase. Losing it can make stored secrets unrecoverable." |
| Envelope | `{ "kmsType": "envelope", "envelopeKeyPath": "/path/in/VAULT_KEY_DIR", "acknowledgeSplitKeyModel": true }` | "The API reads this path on the server host, inside the configured key directory. The browser never uploads the file." |
| File | `{ "kmsType": "file", "masterKeyPath": "/path/in/VAULT_KEY_DIR", "acknowledgeCoLocationRisk": true }` | "File mode keeps key material near the vault host. It is not recommended for production without host hardening." |

**And** the form:

- Does not echo the submitted passphrase or path after submission.
- Clears sensitive input fields on success and on failed submit.
- Does not write passphrase/path values to localStorage, sessionStorage, IndexedDB, cookies, URL params, SvelteKit snapshots, analytics, console logs, or test snapshots.
- Shows validation errors without including the submitted value.
- Shows server errors using the redacted backend message. Example: `Cannot read key file at path: <redacted>`.
- Requires the acknowledgment checkbox for envelope/file modes before enabling submit.

**Example successful file-mode request:**

```http
POST /api/v1/vault/init
Content-Type: application/json

{
  "kmsType": "file",
  "masterKeyPath": "/run/secrets/project-vault/master.key",
  "acknowledgeCoLocationRisk": true
}
```

**Example successful response:**

```json
{
  "initialized": true,
  "keyVersion": 1,
  "kmsType": "file"
}
```

**And** after success, the UI immediately re-checks readiness and routes to login/register only when `/ready` returns `200 { status: "ready" }`.

---

### AC-5: Vault Unseal Form

**Given** the vault is sealed,
**When** the user opens the vault operator flow,
**Then** the UI supports exactly one unseal material input at a time:

| User selects | Request body |
|---|---|
| Passphrase | `{ "passphrase": "..." }` |
| Envelope key file | `{ "envelopeKeyPath": "/path/in/VAULT_KEY_DIR" }` |
| Master key file | `{ "masterKeyPath": "/path/in/VAULT_KEY_DIR" }` |

**And** the UI explains:

```text
The path is read by the API server from the vault host. Do not paste secret file contents here.
```

**And** on `401 UNSEAL_FAILED`, display calm copy:

```text
The vault could not be unsealed with the provided material. Check the key mode and try again.
```

**And** the UI does not mention whether the path exists, whether the passphrase length was close, or any other detail that would create an oracle beyond the backend message.

**And** after success, the UI clears the form, re-checks readiness, and proceeds to auth/app state.

---

### AC-6: Auth Registration Flow

**Given** the vault is ready and no active session exists,
**When** the user registers,
**Then** call:

```http
POST /api/v1/auth/register
Content-Type: application/json

{
  "email": "alex@example.com",
  "password": "twelve-characters",
  "orgName": "Example Org"
}
```

**And** handle success:

```json
HTTP 201
{
  "data": {
    "userId": "00000000-0000-4000-8000-000000000001",
    "orgId": "00000000-0000-4000-8000-000000000002",
    "email": "alex@example.com",
    "orgName": "Example Org",
    "role": "owner"
  }
}
```

**And** after registration, route the user to login unless the backend later explicitly starts returning cookies on registration. Current API does **not** create a session on register.

**And** validation follows backend rules:

- Email must be valid and ASCII-normalized by the backend.
- Password minimum is 12 characters.
- Organization name is 1-128 characters.

**And** frontend validation may improve ergonomics but cannot weaken server validation.

**And** registration-disabled response:

```json
HTTP 403
{ "code": "registration_disabled", "message": "Registration is disabled on this vault" }
```

must render as a normal product state, not a crash.

---

### AC-7: Auth Login Flow

**Given** the vault is ready and a user has an account,
**When** the user logs in without MFA challenge,
**Then** call:

```http
POST /api/v1/auth/login
Content-Type: application/json

{
  "email": "alex@example.com",
  "password": "twelve-characters"
}
```

**And** successful response:

```json
HTTP 200
{
  "data": {
    "userId": "00000000-0000-4000-8000-000000000001",
    "orgId": "00000000-0000-4000-8000-000000000002",
    "expiresAt": "2026-06-27T19:00:00.000Z"
  }
}
```

**And** session state comes only from backend-set HttpOnly cookies. The frontend must not store or parse the access token.

**And** invalid credentials:

```json
HTTP 401
{ "code": "invalid_credentials", "message": "Invalid email or password" }
```

must render with non-alarming copy:

```text
Check your email and password, then try again.
```

**And** after login success, the UI calls `GET /api/v1/auth/me` to populate user/org/session/MFA status and routes to `/dashboard`.

---

### AC-8: Optional MFA Login Step (Conditional on Story 1.12)

**Given** Story 1.12 is complete before Story 2.0 implementation starts,
**When** `POST /api/v1/auth/login` returns:

```json
HTTP 200
{
  "data": {
    "mfaRequired": true,
    "mfaToken": "u8Jx2k4mQ1pZr7sV9aBcDe"
  }
}
```

**Then** the login page transitions to a TOTP verification step and does not route to the app shell.

**And** the frontend holds `mfaToken` only in component state for the current login step:

- Do not store it in localStorage, sessionStorage, IndexedDB, cookies, URL params, module-level long-lived state, logs, or SvelteKit snapshots.
- Clear it when the user leaves the login page, restarts login, or receives `mfa_token_expired`.

**And** submit:

```http
POST /api/v1/auth/mfa/verify-login
Content-Type: application/json

{
  "mfaToken": "u8Jx2k4mQ1pZr7sV9aBcDe",
  "totp": "123456"
}
```

**And** on success, behavior matches normal login: cookies set by backend, call `/auth/me`, route to `/dashboard`.

**And** errors map as follows:

| Error | UI behavior |
|---|---|
| `422 { code: "invalid_totp" }` | Stay on TOTP step, clear only the TOTP input, show "That code was not accepted. Try the next code from your authenticator." |
| `401 { code: "mfa_token_expired" }` | Clear `mfaToken`, return to password step, show "Your login step expired. Please sign in again." |
| validation error | Stay on TOTP step, explain six digits are required. |

**If Story 1.12 is not complete**, do not implement a speculative verify-login route. Add an implementation note in the story completion notes:

```text
MFA login UI intentionally deferred because Story 1.12 backend verify-login API is not complete.
```

and include a skipped conditional test or explicit implementation note referencing Story 1.12, not a passing fake implementation.

---

### AC-9: Server-Side Auth Guard and Silent Refresh

**Given** a user navigates to any `(app)` route,
**When** SvelteKit handles the request,
**Then** `hooks.server.ts` or `(app)/+layout.server.ts` must authenticate server-side:

1. Call `GET /api/v1/auth/me` using incoming cookies.
2. If `/auth/me` succeeds, set `event.locals.user`.
3. If `/auth/me` returns 401, call `POST /api/v1/auth/refresh` with the incoming `refresh-token` cookie.
4. If refresh succeeds, forward backend `Set-Cookie` headers to the browser and retry `/auth/me`.
5. If refresh fails, clear local auth state and redirect to `/login?reason=session-expired`.

**And** do not display a scary security warning for normal expiry/revocation. Use:

```text
Your session ended. Sign in again to continue.
```

**And** unauthenticated access to `/dashboard`, `/projects`, `/credentials`, `/alerts`, `/health`, or `/settings` redirects to `/login`.

**And** authenticated access to `/login` or `/register` redirects to `/dashboard`.

**And** implement the architecture's SSR cookie forwarding requirement: SvelteKit global `fetch` does not automatically forward cookies when calling an API origin. The hook must manually include `Cookie` and forward `Set-Cookie` if the API is not same-origin. [Source: `_bmad-output/planning-artifacts/architecture.md#Auth-Session-Architecture`]

**And** include a simple concurrent refresh guard if multiple server loads can refresh the same request/session at once. Module-level `Map<string, Promise<...>>` keyed by a stable refresh-token hash prefix is the architecture direction; for 2.0, at minimum avoid issuing multiple refresh calls from the same hook execution.

---

### AC-10: Logout Flow

**Given** an authenticated user clicks logout,
**When** the UI submits logout,
**Then** call:

```http
POST /api/v1/auth/logout
Cookie: access-token=...; refresh-token=...
```

**And** handle:

```http
HTTP 204 No Content
Set-Cookie: access-token=; Max-Age=0; ...
Set-Cookie: refresh-token=; Max-Age=0; ...
```

**And** route to `/login?reason=logged-out`.

**And** if logout returns 401/403 because the session is already gone, still clear frontend local user state and route to login. Do not trap the user in the shell.

---

### AC-11: Authenticated App Shell Navigation

**Given** the user is authenticated,
**When** any `(app)` route renders,
**Then** the shell includes responsive navigation for:

- Dashboard (`/dashboard`)
- Projects (`/projects`)
- Credentials (`/credentials`)
- Alerts (`/alerts`)
- Health (`/health`)
- Settings (`/settings`)

**And** desktop layout:

- Shows product name "Project Vault".
- Shows the active section.
- Shows user/org context from `/auth/me` when available.
- Shows logout action.
- Uses the tagline sparingly: "Run complex projects. Miss nothing."

**And** mobile layout:

- Collapses nav into a touch-friendly menu or bottom/top compact navigation.
- Does not require horizontal scrolling at 320px, 375px, or 390px viewport widths.
- Keeps logout reachable.
- Keeps Dashboard reachable in one tap after opening the nav.

**And** placeholder sections render clear non-404 states:

| Section | Required placeholder copy |
|---|---|
| Credentials | "No credentials added yet. Credential storage arrives in Story 2.2." |
| Alerts | "No alert sources configured yet. Notifications and alert routing arrive in Epic 3." |
| Health | "No monitored services configured yet. Service and endpoint monitoring arrives in Epic 6." |
| Settings | "Settings are limited while the MVP shell is being assembled." |

**And** no unavailable section shows fake counts, fake tables, fake charts, green checkmarks, or mock operational activity.

---

### AC-12: Cross-Project Dashboard Empty State

**Given** the user lands on `/dashboard` and no durable project API exists yet,
**When** the dashboard renders,
**Then** it explains the project-centric model directly:

```text
Projects are the home for everything your product depends on: credentials, certificates, services, alerts, and operational context.
```

**And** it reinforces Project Vault's structural difference:

```text
Project Vault organizes by project, not by environment. Add the things that keep one product running in one place.
```

**And** it gives a clear preview-first action:

```text
Preview an empty project dashboard
```

with adjacent copy:

```text
Preview only. Project persistence arrives in Story 2.1. This preview resets when you reload.
```

**And** it shows absence as useful signal, not an error:

- "No projects are saved yet."
- "No credentials added yet."
- "No certificate or domain records added yet."
- "No monitored services configured yet."
- "No alert sources configured yet."

**And** it must not show:

- "All systems healthy"
- "0 alerts" as a green success state
- "100% coverage"
- Any made-up project name, credential count, health status, access event, rotation, or alert
- Sample/demo data unless explicitly inside a non-interactive education panel labeled "Example" and excluded from the dashboard state

---

### AC-13: Project Dashboard Placeholder Uses Story 2.1 Shape

**Given** Story 2.1 will return a project dashboard payload,
**When** Story 2.0 creates preview/placeholder dashboard data,
**Then** use this type shape so the UI can swap in the real API later:

```typescript
export type ProjectDashboardPreview = {
  credentialStats: {
    active: number
    expiringSoon: number
    expired: number
  }
  upcomingRotations: Array<never>
  monitoredServiceHealth: {
    healthy: number
    degraded: number
    down: number
  }
  recentAccessEvents: Array<never>
  unresolvedAlertCount: number
  isEmpty: true
  suggestedActions: Array<'add_credential' | 'add_service' | 'import_credentials'>
}
```

**And** for 2.0 all counts must be zero and all arrays empty:

```typescript
export const EMPTY_PROJECT_DASHBOARD_PREVIEW: ProjectDashboardPreview = {
  credentialStats: { active: 0, expiringSoon: 0, expired: 0 },
  upcomingRotations: [],
  monitoredServiceHealth: { healthy: 0, degraded: 0, down: 0 },
  recentAccessEvents: [],
  unresolvedAlertCount: 0,
  isEmpty: true,
  suggestedActions: ['add_credential', 'add_service', 'import_credentials'],
}
```

**And** the UI labels suggested actions as not-yet-available:

| Suggested action | 2.0 label |
|---|---|
| `add_credential` | "Add first credential - available in Story 2.2" |
| `add_service` | "Add first service - available in Epic 6" |
| `import_credentials` | "Import .env or JSON - available in Story 2.5" |

**And** these actions must not open fake forms or store fake credentials/services.

---

### AC-14: Preview Project State

**Given** the user chooses to preview an empty project dashboard,
**When** the preview route renders,
**Then** it may create an in-memory/module-level preview project object:

```typescript
type PreviewProject = {
  id: 'preview'
  name: string
  description: string
  persisted: false
  dashboard: ProjectDashboardPreview
}
```

**And** the default preview project can be:

```typescript
{
  id: 'preview',
  name: 'Preview Project',
  description: 'A temporary preview of the project-centered dashboard.',
  persisted: false,
  dashboard: EMPTY_PROJECT_DASHBOARD_PREVIEW
}
```

**And** every preview view includes:

```text
Preview only - this project is not saved.
```

**And** the preview resets on reload. Do not persist it to localStorage/sessionStorage/IndexedDB/cookies/database.

**And** tests assert reload/reset behavior at the state-module level by re-importing or resetting module state.

---

### AC-15: Project-Centered UX and Empty State Quality

**Given** UX states that the dashboard is a monitoring surface and empty states are onboarding storytelling,
**When** the dashboard and preview screens render,
**Then** they must follow these UX rules:

- The primary message is operational confidence, not feature marketing.
- Empty state copy shows what belongs in a project: credentials, certificates, domains, services, alerts, and operational notes.
- The UI makes missing categories visible as gaps, not as completed checks.
- Monitoring mode is visually calm and scannable.
- Action-mode CTAs are clearly separated from passive monitoring copy.
- No environment-centric IA appears as the main structure. Do not organize the shell around "dev/staging/prod".

**Required empty-state panel examples:**

```text
Credentials
No credentials added yet.
Credentials will live inside a project with descriptions, tags, expiry dates, and dependent systems.
```

```text
Services and health
No monitored services configured yet.
When service monitoring arrives, this area will show availability and incident signals for this project.
```

```text
Coverage gaps
Project coverage is incomplete because no operational assets have been added yet.
Story 2.1 starts with saved projects; credential and service coverage follow in later stories.
```

**And** the design remains useful for a user who spends only 15-30 seconds scanning the dashboard. [Source: `_bmad-output/planning-artifacts/ux-design-specification.md#Core-User-Experience`]

---

### AC-16: Security, Privacy, and Token Handling

**Given** Project Vault is a data-sensitive platform,
**When** Story 2.0 is complete,
**Then** the frontend must satisfy these security invariants:

| Threat | Required mitigation | Test/review signal |
|---|---|---|
| Access token exfiltration via XSS | Store web session JWTs only in backend-set HttpOnly cookies | Static test/search for `localStorage`, `sessionStorage`, `indexedDB`, token parsing |
| Key path/passphrase leakage | Clear forms after submit and never persist/log submitted values | Component/unit test with mocked submit and console spy |
| Fake operational trust | No fabricated dashboard counts, alerts, health, credentials, rotations, access events | Rendering tests for honest placeholder copy |
| Vault state confusion | Distinct UI states for uninitialized/sealed/unavailable/ready | VaultGate tests |
| Auth-route bypass | Server-side redirects and refresh handling | Load/hook tests |
| MFA token persistence | Hold `mfaToken` only in current component state when 1.12 is present | Conditional test if MFA is implemented |
| HTML injection | No `{@html}` usage | ESLint already forbids `svelte/no-at-html-tags`; do not disable it |

**And** do not add analytics, session replay, or client logging of request/response bodies in this story.

**And** if any test uses console logging, redact request bodies and secrets before snapshotting.

---

### AC-17: Accessibility and Mobile

**Given** the web app must be clean across desktop, tablet, and mobile,
**When** Story 2.0 UI is implemented,
**Then**:

- All forms have explicit labels.
- Error messages are associated with their fields.
- Keyboard users can complete init, unseal, register, login, logout, and nav flows.
- Focus moves to the first meaningful heading or error after route/form transitions.
- Buttons have accessible names that include the action ("Initialize vault", "Unseal vault", "Sign in", "Sign out").
- Color is not the only indicator of state.
- Primary flows do not require horizontal scroll at 320px viewport width.
- Navigation is touch-friendly on mobile.
- Empty-state cards remain readable on mobile.

**And** automated tests include at least one mobile viewport smoke test. If using a DOM-only test environment, implement this as a structural/class assertion and document that full responsive verification is manual until Playwright or equivalent is added.

**And** manual QA includes browser checks at 320px, 375px, 768px, and desktop width.

---

### AC-18: Automated Tests

**Given** repo rules require TDD red-green for story implementation,
**When** a dev agent starts Story 2.0,
**Then** write/update focused failing tests first and confirm they fail for the expected reason before implementing UI/code.

**Required test files/scenarios:**

```text
apps/web/src/lib/api/auth.test.ts
  - register sends expected body and returns data
  - login success returns session data without exposing tokens
  - logout handles 204
  - auth errors normalize { code, message }

apps/web/src/lib/api/vault.test.ts
  - ready: 200 ready -> ready state
  - ready: uninitialized response -> uninitialized state
  - ready: sealed response -> sealed state
  - ready: db/network failure -> unavailable state
  - init/unseal requests never include extra mode fields

apps/web/src/lib/state/preview-project.test.ts
  - preview dashboard uses Story 2.1 shape
  - preview project is persisted: false
  - reset clears preview state

apps/web/src/routes/auth-guard.test.ts or hooks.server.test.ts
  - unauthenticated app route redirects to /login
  - valid /auth/me populates locals
  - expired access + valid refresh retries /auth/me and forwards Set-Cookie
  - refresh failure redirects with reason=session-expired

apps/web/src/routes/dashboard.test.ts
  - empty dashboard renders project-centric explanation
  - no fake healthy/success/count copy appears
  - preview-only warning is visible near preview action

apps/web/src/routes/vault.test.ts
  - uninitialized shows only init action
  - sealed shows only unseal action
  - unavailable shows retry only
  - submitted key path/passphrase is not echoed after submit

apps/web/src/routes/mobile-smoke.test.ts
  - app shell exposes mobile navigation controls
  - primary pages use responsive classes and no fixed desktop-only min-width
```

**And** tests must fail before implementation because the current app has only a placeholder page and placeholder test.

**And** if adding new frontend test dependencies is necessary, prefer current ecosystem packages compatible with SvelteKit 2/Svelte 5 and add them through `pnpm` rather than manually editing versions.

**And** all tests avoid snapshotting secret-looking values.

---

### AC-19: Manual QA Checklist

Run these after focused tests pass:

```bash
pnpm --filter @project-vault/web test
pnpm --filter @project-vault/web typecheck
pnpm --filter @project-vault/web lint
pnpm typecheck
pnpm lint
```

Manual browser checks:

1. Start API and web locally using repo scripts.
2. With vault uninitialized, open web root and confirm only initialization is offered.
3. Initialize with passphrase or file mode; confirm inputs clear after submit.
4. Restart or force sealed state; confirm unseal flow appears and no auth/app shell appears.
5. Register a user; confirm registration does not imply active session unless backend returns cookies.
6. Log in; confirm dashboard appears and `/auth/me` user/org context is visible.
7. Refresh the page; confirm session persists by cookie.
8. Revoke/expire session or clear cookies; confirm app route redirects to login with calm copy.
9. Click logout; confirm cookies are cleared by backend and shell disappears.
10. Open Dashboard, Projects, Credentials, Alerts, Health, Settings; confirm every unavailable area is an honest placeholder.
11. Preview empty project dashboard; confirm preview-only warning appears and reload clears preview state.
12. Check 320px, 375px, 768px, and desktop widths for no horizontal scrolling in primary flows.

---

### AC-20: Explicit Out of Scope

Do **not** implement any of the following in Story 2.0:

- Durable `projects` database table, project memberships, project RLS, or project CRUD API, unless the story is explicitly re-scoped before development. This is Story 2.1.
- Storing, revealing, searching, importing, or versioning credential values.
- Real credential count, credential expiry, rotation schedule, access events, or credential search.
- Real alert delivery, notification inbox, Slack/email notifications, or threshold alert configuration.
- Real service, certificate, domain, uptime, or public status-page monitoring.
- Rotation workflows, dependent-system management, machine users, API keys, audit-log UI, compliance exports, backup/restore UI, full onboarding wizard, Shamir unseal UX.
- Fake demo data that implies unavailable capabilities are functional.
- Token storage in browser storage or JavaScript-accessible memory.
- Refactoring Epic 1 backend auth/vault behavior beyond the small optional `/ready` uninitialized reason fix.

---

### AC-21: Tasks / Subtasks

> Follow repo TDD red-green (`AGENTS.md`): write or update failing tests first, confirm they fail for the expected reason, implement the smallest change, then rerun focused and relevant broader checks.

- [ ] **Task 1: Confirm backend contracts and decide MFA branch** (AC: 2, 3, 8)
  - [ ] Verify Story 1.12 implementation status in code, not only sprint status.
  - [ ] Decide whether to implement MFA login UI or add blocked note.
  - [ ] Add failing API-helper tests for current auth/vault response shapes.
- [ ] **Task 2: API client helpers** (AC: 2, 6, 7, 10)
  - [ ] Implement `lib/api/client.ts`, `auth.ts`, and `vault.ts`.
  - [ ] Normalize `{ code, message }` and `{ error, message }` errors.
  - [ ] Ensure `credentials: 'include'` is always used.
- [ ] **Task 3: Vault gate** (AC: 3, 4, 5)
  - [ ] Implement readiness classification tests.
  - [ ] Implement `VaultGate`, `VaultInitForm`, `VaultUnsealForm`.
  - [ ] Optional backend fix: change `/ready` uninitialized reason to `uninitialized` with API test.
- [ ] **Task 4: Auth pages** (AC: 6, 7, 8)
  - [ ] Implement register/login forms and post-register routing.
  - [ ] Implement conditional MFA step only if 1.12 backend exists.
  - [ ] Ensure no token/key material enters browser storage.
- [ ] **Task 5: Server-side route guards and refresh** (AC: 9)
  - [ ] Add `hooks.server.ts` and `app.d.ts` locals.
  - [ ] Authenticated routes redirect unauthenticated users.
  - [ ] Refresh flow forwards cookies and retries `/auth/me`.
- [ ] **Task 6: App shell and navigation** (AC: 11, 17)
  - [ ] Add authenticated layout and responsive nav.
  - [ ] Implement logout.
  - [ ] Add mobile structural smoke test.
- [ ] **Task 7: Empty dashboard and preview state** (AC: 12, 13, 14, 15)
  - [ ] Add Story 2.1-shaped preview payload.
  - [ ] Add reset-on-reload preview project state.
  - [ ] Render cross-project and project dashboard empty states.
  - [ ] Assert no fake operational data appears.
- [ ] **Task 8: Placeholder sections** (AC: 11, 20)
  - [ ] Credentials, Alerts, Health, Settings render honest placeholders.
  - [ ] No 404s for primary shell nav.
- [ ] **Task 9: Security and accessibility hardening** (AC: 16, 17)
  - [ ] Add static/storage/logging tests where practical.
  - [ ] Verify labels, focus behavior, keyboard flows.
- [ ] **Task 10: Final verification** (AC: 18, 19)
  - [ ] Run focused web tests.
  - [ ] Run `pnpm --filter @project-vault/web typecheck` and `lint`.
  - [ ] Run relevant root checks if time allows.
  - [ ] Complete manual QA checklist.

---

### AC-22: ADRs

#### ADR-2.0-01: Preview stub for "Create project" instead of partial real project API

| | |
|---|---|
| **Context** | The epic offers two paths: implement a minimal real `POST /api/v1/projects` + `GET /api/v1/projects` subset now, or use an explicitly labeled in-memory preview stub. No `projects` table, project RLS, or project membership model exists yet (`packages/db/src/schema/audit-log-entries.ts` defers the `projects(id)` FK to Story 2.1). |
| **Options** | **A** — Build the real project subset in 2.0 using Story 2.1's final schema + RLS. **B** — In-memory preview stub, reset-on-reload, clearly labeled non-persistent. |
| **Decision** | **Option B.** Story 2.0 ships a preview-only project dashboard; durable project persistence, schema, and RLS are owned entirely by Story 2.1. |
| **Rationale** | Option A would split Story 2.1's schema/RLS work across two stories, creating a half-built `projects` table and org-scoping surface that a later story must reconcile — exactly the migration/RLS risk the architecture warns against. The product goal of 2.0 (validate the project-centric mental model) is met by a labeled preview without durable persistence. |
| **Consequences** | The shell cannot demonstrate persistence across reloads. Mitigated by explicit "Preview only … resets when you reload" copy (AC-12/AC-14). If the team later prefers Option A, this ADR must be revisited **before** development and Story 2.1's schema must land first. |

#### ADR-2.0-02: Vault state classification depends on `/ready`, with a preferred small backend fix

| | |
|---|---|
| **Context** | The epic expects four distinct vault states (uninitialized, sealed, unavailable, ready). Today `GET /ready` returns `503 { reason: "sealed" }` for **both** uninitialized and sealed, differing only in `message`. |
| **Options** | **A** — Frontend classifies uninitialized vs sealed by parsing the `message` string. **B** — Small backend change so the uninitialized branch returns `reason: "uninitialized"`; frontend classifies on the stable `reason` field. |
| **Decision** | **Option B preferred**, with Option A as a documented fallback if backend changes are out of scope for the assigned dev. |
| **Rationale** | Branching on a free-text `message` is brittle and breaks silently if copy changes. A stable machine-readable `reason` is the correct contract for a UI state machine, and the change is small and additive (preserves existing sealed behavior). |
| **Consequences** | Option B requires updating `apps/api/src/routes/health.ts` and its tests. If Option A is used, an implementation note must flag the `/ready` ambiguity; the two states must never collapse into one. |

#### ADR-2.0-03: Browser sessions are HttpOnly-cookie only; the frontend never holds tokens

| | |
|---|---|
| **Context** | Project Vault is a data-sensitive platform. Architecture mandates web session JWTs live only in `HttpOnly; Secure; SameSite=Strict` cookies. |
| **Options** | **A** — Store access token in JS-accessible memory/localStorage for convenience. **B** — Rely entirely on backend-set HttpOnly cookies; client uses `credentials: 'include'`; never read or parse the JWT. |
| **Decision** | **Option B.** No access, refresh, MFA, or vault material is ever placed in `localStorage`, `sessionStorage`, `IndexedDB`, JS memory, URL params, or SvelteKit snapshots. |
| **Rationale** | HttpOnly storage makes the token invisible to JavaScript, removing the primary XSS exfiltration path. This is non-negotiable for a secrets platform and matches Epic 1's established auth model. |
| **Consequences** | Session presence must be inferred via `GET /auth/me`, not by reading a token. Enforced by static search tests in AC-16/AC-18. |

#### ADR-2.0-04: Authentication is enforced server-side (hooks/server load), not client-only

| | |
|---|---|
| **Context** | SvelteKit can guard routes client-side or server-side. SSR `fetch` does not auto-forward cookies, and parallel `load` functions can race on refresh. |
| **Options** | **A** — Client-side guard in `+layout.svelte`/onMount. **B** — Server-side guard in `hooks.server.ts` / `(app)/+layout.server.ts` with manual cookie forwarding and a concurrent-refresh guard. |
| **Decision** | **Option B.** Auth resolution, silent refresh, and redirects happen server-side before protected content renders. |
| **Rationale** | Client-only guards flash protected UI before redirecting and can leak structure. Server-side resolution is the architecture's stated pattern and the only correct place to forward `Cookie`/`Set-Cookie` for SSR refresh. |
| **Consequences** | Requires `hooks.server.ts`, `app.d.ts` locals, and explicit `Set-Cookie` forwarding. A minimal in-flight refresh guard is required to avoid refresh races (AC-9). |

#### ADR-2.0-05: MFA login UI is conditional on Story 1.12 backend, never speculative

| | |
|---|---|
| **Context** | Story 1.12 (`POST /auth/mfa/verify-login` + `mfaRequired` login branch) is `ready-for-dev`, not done. Story 2.0 may be implemented before or after it. |
| **Options** | **A** — Build the MFA login UI now against the *specified* 1.12 contract. **B** — Implement MFA login UI only if the 1.12 backend has landed; otherwise defer with an explicit blocked note and a skipped conditional test. |
| **Decision** | **Option B.** Gate the MFA login step on verified backend existence (checked in code, not just sprint status). |
| **Rationale** | Building UI against an unshipped endpoint risks contract drift and a fake-passing flow that cannot be exercised end-to-end. Conditional implementation keeps the non-MFA login path honest and shippable independently. |
| **Consequences** | If 1.12 is absent, login supports only the non-MFA path and the completion notes record the deferral. The `mfaRequired` response shape must stay aligned with Story 1.12 to avoid rework. |

#### ADR-2.0-06: Unavailable sections render honest placeholders, never fabricated operational state

| | |
|---|---|
| **Context** | The shell exposes Dashboard, Projects, Credentials, Alerts, Health, Settings, but their backing APIs (Epics 2.2+, 3, 6) do not exist yet. "Green silence" is the eventual monitoring goal. |
| **Options** | **A** — Seed demo/sample data or show "all healthy/0 alerts" success states to make the shell feel complete. **B** — Render explicit empty/not-configured states with no fabricated counts, health, or success affordances. |
| **Decision** | **Option B.** No green/healthy/success state, no fake counts, no mock activity until a real backing API exists. |
| **Rationale** | For a trust product, a fabricated "all healthy" is actively harmful — it implies coverage that does not exist and undermines the exact confidence the product sells (epic AC-E2f). Absence must read as honest gap, not false safety. |
| **Consequences** | The shell looks intentionally sparse pre-Epic-2.2+. Enforced by rendering tests asserting honest copy and absence of success/health language (AC-11/AC-12/AC-18). |

---

## Dev Notes

### Project Structure Notes

| Area | Guidance |
|---|---|
| Frontend framework | SvelteKit 2 + Svelte 5, runes-first. |
| Styling | Tailwind CSS v4. Keep monitoring surfaces dense but calm. |
| Components | Feature components under `src/lib/components/{auth,vault,shell,dashboard}`. UI primitives under `src/lib/components/ui` only if shadcn-svelte primitives are introduced. |
| State | Use local `$state` and small module-level rune state. No external state library. |
| API | Use typed helpers in `src/lib/api`. Do not scatter raw `fetch` calls through components. |
| Auth | Browser sessions use HttpOnly cookies only. Do not parse JWTs in frontend code. |
| Tests | Existing test is placeholder; replace/expand with focused behavior tests. |

### Current Web Scaffold

Current `apps/web/src/routes/+page.svelte` only renders:

```text
Project Vault
Run complex projects. Miss nothing.
```

Story 2.0 is the first meaningful web-app implementation. Expect broad additions under `apps/web/src`, but keep the behavioral scope narrow.

### API Contracts to Consume

| API | Current behavior |
|---|---|
| `GET /ready` | `200 { status: "ready" }` or `503 { status: "unavailable", reason, message/retryAfter }`. |
| `POST /api/v1/vault/init` | Returns `{ initialized: true, keyVersion, kmsType }`. |
| `POST /api/v1/vault/unseal` | Returns `{ unsealed: true, keyVersion, kmsType }`. |
| `POST /api/v1/auth/register` | Returns `201 { data: { userId, orgId, email, orgName, role: "owner" } }`; no session cookies. |
| `POST /api/v1/auth/login` | Returns `200 { data: { userId, orgId, expiresAt } }` plus HttpOnly cookies, unless Story 1.12 MFA branch exists. |
| `POST /api/v1/auth/refresh` | Uses refresh cookie, returns refreshed session cookies and expiry. |
| `POST /api/v1/auth/logout` | Returns `204` and clears cookies. |
| `GET /api/v1/auth/me` | Returns user/org/session/MFA enforcement data. |

### Latest Tech Information

| Technology | Repo version / source | Story impact |
|---|---|---|
| SvelteKit | `@sveltejs/kit` `^2.16.0` in `apps/web/package.json` | Use route groups, server loads, `hooks.server.ts`, adapter-node. |
| Svelte | `^5.20.0` | Prefer runes and Svelte 5-compatible test approach. |
| Tailwind CSS | `^4.0.0` with `@tailwindcss/vite` | Keep styles utility-first; no separate CSS framework. |
| Vitest | `^3.2.6` | Use focused unit/component tests. |
| jsdom | `^26.0.0` | DOM tests can render forms/state; full browser E2E is not required unless added deliberately. |
| Node | repo requires `>=24.0.0` | Do not add tooling that conflicts with Node 24. |
| API auth | HttpOnly cookies, SameSite strict | Client uses `credentials: 'include'`; no token storage. |

### UX Guardrails

- The dashboard is a monitoring surface. It should communicate absence clearly.
- Empty states are onboarding storytelling, not dead ends.
- Project is the organizing primitive. Do not make environment the primary IA.
- Missing categories are coverage gaps, not success.
- Correct security behavior should be visible and useful, not hidden in help text.

### Anti-Patterns (Do Not)

- Do not show fake dashboard data.
- Do not show green/healthy success states before real health APIs exist.
- Do not persist preview projects.
- Do not implement partial durable project APIs without Story 2.1 schema/RLS.
- Do not store auth tokens, MFA tokens, passphrases, or key paths in browser storage.
- Do not log auth/vault request bodies from the frontend.
- Do not make `/health` equivalent to app readiness.
- Do not expose init/unseal forms while the app is already ready.
- Do not route authenticated users through client-only guards; server-side guard is required.
- Do not create a new design system or add a component library beyond the architecture's shadcn-svelte direction.
- Do not use `{@html}`.

---

## Previous Story Intelligence

No prior Epic 2 story file exists. Relevant carry-forward intelligence comes from Epic 1:

- Story 1.6 established cookie-based auth. Success sessions are set via HttpOnly cookies, not returned as raw tokens.
- Story 1.7 established refresh/session revocation behavior. Frontend must treat refresh and revocation as normal session lifecycle.
- Story 1.8/1.9 added MFA status and enforcement data to auth context. The app shell should preserve this signal for future MFA enrollment prompts.
- Story 1.10 emphasized structured logging and redaction. Frontend must not introduce client logging that bypasses redaction expectations.
- Story 1.12 is the intended backend dependency for MFA login UI. Do not invent its API if it is not implemented.

---

## Git Intelligence Summary

Recent commits on this branch focus on Epic 1 security/platform work:

- `569fa5d fix(core): improvments to structured operational logging and metrics`
- `e40efec fix(core): improvements to structured operational logging and metrics`
- `2dfb93e feat(core): structured operational loggin and metrics`
- `dd6429e fix(core): code review fixes for story 1.9 mfa enforcement and failed auth detection`
- `35301bd feat(core): mfa role enforcement and failed authentication detection`

Implication: the codebase is security-heavy and API-first. Story 2.0 should consume established contracts and avoid widening backend security scope.

---

## References

- Story source: `_bmad-output/planning-artifacts/epics.md#Story-2.0-MVP-Frontend-Shell--Empty-Project-Dashboard`
- Story 2.1 project/dashboard response shape: `_bmad-output/planning-artifacts/epics.md#Story-2.1-Project-Creation--Cross-Project-Dashboard`
- Epic 2 caveats and honest placeholder requirement: `_bmad-output/planning-artifacts/epics.md#Epic-2-Secret--Credential-Management--Store-Retrieve-Search--Import`
- Frontend architecture: `_bmad-output/planning-artifacts/architecture.md#Frontend-Architecture`
- Auth cookie architecture and SSR refresh requirements: `_bmad-output/planning-artifacts/architecture.md#Auth-Model`
- UX empty-state and monitoring principles: `_bmad-output/planning-artifacts/ux-design-specification.md#Design-Opportunities`
- Product dashboard and project-centric validation: `_bmad-output/planning-artifacts/prd.md#Validation-Approach`
- Current web package: `apps/web/package.json`
- Current health/readiness API: `apps/api/src/routes/health.ts`
- Current auth routes: `apps/api/src/modules/auth/routes.ts`
- Current vault routes/schemas: `apps/api/src/modules/vault/routes.ts`, `apps/api/src/modules/vault/schema.ts`
- Project table deferral note: `packages/db/src/schema/audit-log-entries.ts`
- Repo TDD rule: `AGENTS.md`

---

## Dev Agent Record

### Agent Model Used

_(to be filled by dev agent)_

### Debug Log References

### Completion Notes List

### File List
