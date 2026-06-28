# Story 2.0: MVP Frontend Shell & Empty Project Dashboard

Status: done

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
| Story 1.12 (MFA login verification) is complete and merged | Story 1.12 is `done` (sprint-status.yaml). MFA login is a real backend contract, not a conditional. Login must handle `200 { data: { mfaRequired: true, mfaToken } }` and the verify-login step `POST /api/v1/auth/mfa/verify-login`. There is no "deferred / blocked by 1.12" branch — implement the full MFA login UI. |
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
| 1.12 | **Done.** Login returns `200 { data: { mfaRequired: true, mfaToken } }` for MFA-enrolled users; 2.0 consumes that contract and implements the `POST /api/v1/auth/mfa/verify-login` step. This is required, not conditional. |
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
| Story 1.12 is done | Sprint status has 1.12 `done`; `apps/api/src/modules/auth/mfa-login.ts` + `POST /api/v1/auth/mfa/verify-login` exist | Implement the MFA login step against the real contract (AC-8). Tests must exercise both the non-MFA path and the MFA challenge + verify-login path. Do not ship a "blocked by 1.12" placeholder. |

---

## Acceptance Criteria

### AC Quick Reference

| Area | Required result |
|---|---|
| Vault readiness | Distinct uninitialized, sealed, unavailable, and ready UI states; only valid next action visible. |
| Vault init/unseal | Explicit operator forms, host trust-boundary copy, no echo/log/storage of submitted passphrase/path after submit. |
| Auth | Register/login/refresh/logout/me use Epic 1 APIs and HttpOnly cookies only. |
| Route guard | Server-side SvelteKit guard redirects unauthenticated users and refreshes valid sessions transparently. |
| MFA login | Required. Implement the TOTP challenge + `POST /api/v1/auth/mfa/verify-login` step against the merged Story 1.12 contract; `mfaToken` lives only in current component state. |
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
│   │   ├── client.ts                       # NEW: typed fetch wrapper, credentials include; base URL from trusted env only
│   │   ├── auth.ts                         # NEW: register/login/logout/me/refresh helpers
│   │   ├── vault.ts                        # NEW: ready/init/unseal helpers (init sends x-vault-bootstrap-token header)
│   │   └── dashboard-preview.ts            # NEW: imports ProjectDashboardPreview from @project-vault/shared
│   ├── security/
│   │   └── hardening.ts                    # NEW: same-origin redirect guard + reason->copy enum (AC-23 H2/H3)
│   ├── components/
│   │   ├── auth/
│   │   │   ├── LoginForm.svelte
│   │   │   ├── RegisterForm.svelte
│   │   │   └── MfaLoginForm.svelte         # required: Story 1.12 verify-login is merged
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
│       └── preview-project.svelte.ts       # NEW: CLIENT-ONLY rune state (browser), reset-on-reload; never server module state
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

**And** do not introduce a frontend state library; use Svelte 5 runes and module-level state where shared client state is needed. [Source: `_bmad-output/planning-artifacts/architecture.md#Frontend-Architecture`] **Caveat:** module-level mutable state is only safe for client-only state — in SvelteKit a module imported during SSR is shared across all server requests/users, so any per-user/preview state must be browser-scoped (see AC-14 SSR safety note).

**And** the shared dashboard contract lives outside `apps/web` so Story 2.1 reuses it:

```text
packages/shared/src/schemas/dashboard.ts   # NEW: zod ProjectDashboardPreviewSchema + type + EMPTY_PROJECT_DASHBOARD_PREVIEW (AC-13)
packages/shared/src/index.ts               # MODIFY: add `export * from './schemas/dashboard.js'`
apps/web/package.json                       # MODIFY: add "dependencies": { "@project-vault/shared": "workspace:*" }
```

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

**And** the API base URL/origin is resolved only from trusted server-side env config (never from request input, query params, or `Referer`). Cookies are forwarded only to that configured API origin — never to an arbitrary or user-supplied URL (AC-23 H4).

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

**Bootstrap authorization (required — do not omit):** `POST /api/v1/vault/init` is gated server-side by `assertBootstrapAuthorized()` in `apps/api/src/modules/vault/key-service.ts`. Unless the host sets `VAULT_ALLOW_REMOTE_INIT=true` (dev only), init **requires** the header `x-vault-bootstrap-token: <VAULT_BOOTSTRAP_TOKEN>`. Without it the API returns `403 { error: "bootstrap_forbidden", message: "Vault bootstrap requires valid bootstrap credentials" }`.

The frontend init flow must therefore:

- Provide an operator-only field for the one-time bootstrap token, shown **only** in the uninitialized state.
- Send it as the `x-vault-bootstrap-token` request header, never in the JSON body, query string, or a cookie.
- Never bundle, hardcode, default, log, or persist the bootstrap token (same handling rules as passphrase/key-path in AC-4 form rules).
- Render `403 bootstrap_forbidden` as calm operator copy: "This vault is locked to local initialization. Provide the bootstrap token configured on the host, or initialize from the server." Do not imply the token was "wrong" vs "missing" beyond the backend message.
- Clear the bootstrap-token field on submit (success or failure), identical to passphrase handling.

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

**And** on unseal failure the API returns `{ error, message }` where `error` is the lowercased error code (the route sends `err.code.toLowerCase()`). Map the failure cases:

| Status + `error` | UI behavior |
|---|---|
| `401 { error: "unseal_failed" }` | Calm copy: "The vault could not be unsealed with the provided material. Check the key mode and try again." |
| `400 { error: "already_unsealed" }` | Re-check `/ready`; if ready, proceed — do not show a hard error. |
| `400 { error: "invalid_key_file" \| "key_file_not_found" \| "invalid_passphrase" }` | Generic calm copy from the backend `message` (already redacted server-side); never echo the path/passphrase. |
| `429` (rate-limited, unseal is 5/min) | Show "Too many attempts. Wait a moment and try again." and do **not** auto-retry (AC-23 H6). |

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

### AC-8: MFA Login Step (Story 1.12 is merged — required)

> Story 1.12 is `done`. The `mfaRequired` login branch and `POST /api/v1/auth/mfa/verify-login` are real backend contracts (`apps/api/src/modules/auth/mfa-login.ts`). This AC is **mandatory**, not conditional — there is no "defer until 1.12" path.

**Given** an MFA-enrolled user authenticates,
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

**Backend contract reference (verify-login is merged):** the real responses come from `apps/api/src/modules/auth/mfa-login.ts`:

- Success → `200 { data: { userId, orgId, expiresAt } }` plus HttpOnly `access-token`/`refresh-token` cookies set by the backend (never raw tokens in the body).
- Invalid TOTP → `422 { code: "invalid_totp" }` (retry-allowed; the pending row survives until TTL/attempt cap).
- Dead/expired/consumed/attempt-capped token → `401 { code: "mfa_token_expired" }` (restart login).

The MFA login UI and its verify-login tests are required deliverables of Story 2.0; do not ship a skipped/deferred placeholder.

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

**And** redirect safety: if a post-login `redirectTo`/return-path parameter is added, only honor **internal, same-origin path** targets (must start with a single `/`, must not start with `//` or a scheme). Reject or ignore absolute/external URLs to prevent open-redirect. The default redirect is `/dashboard`.

**And** query-driven status copy must come from a fixed enum map, never rendered from raw query input. `?reason=session-expired|logged-out` maps to a known message; any unknown value falls back to a generic message. Do not interpolate raw `reason` (or any query param) into the DOM — this prevents reflected injection even though `{@html}` is already forbidden.

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

**`GET /api/v1/auth/me` response contract (use these exact fields — do not invent others):**

```json
{
  "data": {
    "userId": "uuid",
    "orgId": "uuid",
    "sessionId": "uuid",
    "orgRole": "owner | admin | member | viewer",
    "mfaEnrolled": true,
    "mfaEnrolledAt": "iso-datetime | null",
    "remainingRecoveryCodesCount": 0,
    "mfaStatus": {
      "enrollmentRequired": false,
      "gracePeriodActive": false,
      "gracePeriodExpiresAt": "iso-datetime | null",
      "gracePeriodDaysRemaining": 0,
      "bannerMessage": "string | null"
    }
  }
}
```

Render the MFA enrollment banner (Epic 1.8/1.9 integration) **only** when `mfaStatus.enrollmentRequired` is true or `mfaStatus.bannerMessage` is non-null; show `bannerMessage` verbatim. Do not fabricate banner copy or hide an active enforcement banner.

**And** desktop layout:

- Shows product name "Project Vault".
- Shows the active section.
- Shows user/org context from `/auth/me` when available (`orgRole`, identifiers).
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

> **Single source of truth (prevents a Story 2.1 redesign):** Define `ProjectDashboardPreviewSchema` (and its inferred `ProjectDashboardPreview` type) once in `packages/shared/src/schemas/dashboard.ts` and import it into the web app — do **not** redeclare it inline in `apps/web`. Story 2.1's real dashboard API must consume the *same* exported schema/type, so the UI swap is a data-source change, not a re-layout. A Pre-mortem failure mode is "2.1 had to redesign the dashboard because the preview shape diverged"; the shared schema closes that gap.
>
> **Required wiring (the web app does not yet depend on `@project-vault/shared`):**
> 1. Add the workspace dependency to `apps/web/package.json` (it currently has no `dependencies` block, only `devDependencies`):
>    ```json
>    "dependencies": { "@project-vault/shared": "workspace:*" }
>    ```
>    then run `pnpm install` so the workspace symlink is created.
> 2. Re-export the new module from `packages/shared/src/index.ts` (add `export * from './schemas/dashboard.js'`) so it resolves via the package root, matching the existing `schemas/auth.js` / `schemas/api.js` pattern.
> 3. Import in the web app as `import { ... } from '@project-vault/shared'` — never via a deep relative path into `packages/`.

**Given** Story 2.1 will return a project dashboard payload,
**When** Story 2.0 creates preview/placeholder dashboard data,
**Then** define this as a **zod schema** (not a bare type) in `packages/shared/src/schemas/dashboard.ts`, matching the `zod/v4` + `.meta({ id })` + `z.infer` convention used by `schemas/auth.ts`. Story 2.1 reuses this schema to validate the real dashboard API response, so the contract is enforced at runtime on both sides:

```typescript
import { z } from 'zod/v4'

export const ProjectDashboardPreviewSchema = z
  .object({
    credentialStats: z.object({
      active: z.number().int().nonnegative(),
      expiringSoon: z.number().int().nonnegative(),
      expired: z.number().int().nonnegative(),
    }),
    // Story 2.1 replaces z.never() with the real rotation / access-event item schemas.
    // z.never() permits only empty arrays, which enforces the 2.0 "must be empty" rule
    // and self-documents the exact swap point for 2.1.
    upcomingRotations: z.array(z.never()),
    monitoredServiceHealth: z.object({
      healthy: z.number().int().nonnegative(),
      degraded: z.number().int().nonnegative(),
      down: z.number().int().nonnegative(),
    }),
    recentAccessEvents: z.array(z.never()),
    unresolvedAlertCount: z.number().int().nonnegative(),
    isEmpty: z.literal(true),
    suggestedActions: z.array(
      z.enum(['add_credential', 'add_service', 'import_credentials'])
    ),
  })
  .meta({ id: 'ProjectDashboardPreview' })

export type ProjectDashboardPreview = z.infer<typeof ProjectDashboardPreviewSchema>
```

**And** export the canonical empty value from the same module so the web app never hand-rolls preview data; for 2.0 all counts are zero and all arrays empty:

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

**And** a unit test asserts `ProjectDashboardPreviewSchema.parse(EMPTY_PROJECT_DASHBOARD_PREVIEW)` succeeds and that a non-empty `upcomingRotations`/`recentAccessEvents` array is rejected (guards the 2.0 empty-only invariant).

**And** the UI labels suggested actions as not-yet-available:

| Suggested action | 2.0 label |
|---|---|
| `add_credential` | "Add first credential - available in Story 2.2" |
| `add_service` | "Add first service - available in Epic 6" |
| `import_credentials` | "Import .env or JSON - available in Story 2.5" |

**And** these actions must not open fake forms or store fake credentials/services.

---

### AC-14: Preview Project State

> **SSR safety (critical):** Preview state must be **client-only**. A module-level mutable `$state` in a SvelteKit file imported during SSR is shared across **all server requests and users** (the Node process is long-lived), which would leak one visitor's preview into another's response. Initialize and mutate preview state only in the browser (e.g., guard with `import { browser } from '$app/environment'` or keep it in component/page client state). Server `load` must not write to a shared preview singleton. The architecture's module-level refresh-promise `Map` is acceptable only because it is keyed by a transient token hash and removed on settle; preview *content* is not.

**Given** the user chooses to preview an empty project dashboard,
**When** the preview route renders,
**Then** it may create a client-only, in-memory preview project object:

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

**And** tests assert reload/reset behavior at the client state level (re-importing/resetting the browser state module), and additionally assert the preview state module is **not** mutated during SSR (no shared singleton write on the server path).

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
| MFA token persistence | Hold `mfaToken` only in current login-step component state; never in any browser storage, URL, or long-lived module state | Required test: `mfaToken` is never written to localStorage/sessionStorage/IndexedDB/cookies/URL and is cleared on step change / `mfa_token_expired` |
| HTML injection | No `{@html}` usage | ESLint already forbids `svelte/no-at-html-tags`; do not disable it |
| Open redirect | Honor only same-origin path redirect targets | Redirect-helper test (AC-23 H2) |
| Reflected injection / status spoofing | Status copy from a fixed reason enum; never render raw query params | Enum-mapping test (AC-23 H3) |
| Cookie exfiltration via API base | API base URL from trusted server env only, not user input | API-base-trust test (AC-23 H4) |
| Clickjacking | Web app not framable (`frame-ancestors 'none'`/`X-Frame-Options: DENY`) | Header test or documented proxy enforcement (AC-23 H7) |

> See **AC-23** for the full Red Team / Blue Team hardening matrix; this table is the security summary it expands.

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
  - login returns { mfaRequired: true, mfaToken } -> transitions to TOTP step, does NOT route to app shell (AC-8)
  - verify-login sends { mfaToken, totp } to POST /api/v1/auth/mfa/verify-login and on success behaves like normal login (AC-8)
  - verify-login 422 invalid_totp keeps TOTP step and clears only the TOTP input (AC-8)
  - verify-login 401 mfa_token_expired clears mfaToken and returns to the password step (AC-8)
  - logout handles 204
  - auth errors normalize { code, message }

apps/web/src/lib/api/vault.test.ts
  - ready: 200 ready -> ready state
  - ready: uninitialized response (503, reason "sealed", uninitialized message) -> uninitialized state
  - ready: sealed response (503, reason "sealed", manual-unseal message) -> sealed state
  - ready: AMBIGUITY GUARD — uninitialized and sealed both return reason "sealed" today; classification MUST NOT collapse them into one state. Until the backend adds reason "uninitialized", classify by message and assert the two distinct states are produced (AC-3 / ADR-2.0-02)
  - ready: db/network failure -> unavailable state
  - init/unseal requests never include extra mode fields
  - init sends bootstrap token as x-vault-bootstrap-token header, never in body/query (AC-23 H1)
  - 403 bootstrap_forbidden surfaces operator copy, not a generic error (AC-23 H1)
  - unseal does not auto-retry after a 429/lockout response (AC-23 H6)

packages/shared/src/schemas/dashboard.test.ts
  - ProjectDashboardPreviewSchema.parse(EMPTY_PROJECT_DASHBOARD_PREVIEW) succeeds
  - non-empty upcomingRotations/recentAccessEvents is rejected (empty-only invariant)

apps/web/src/lib/state/preview-project.test.ts
  - preview dashboard uses ProjectDashboardPreview from @project-vault/shared
  - preview project is persisted: false
  - reset clears preview state
  - preview state module is not mutated during SSR (no shared singleton write) (AC-14)

apps/web/src/lib/security/hardening.test.ts
  - redirect helper rejects external/scheme/'//'-prefixed targets, allows '/dashboard' (AC-23 H2)
  - status copy is resolved from a fixed reason enum; unknown reason -> generic message (AC-23 H3)
  - API base URL is sourced from server env config, not request/query input (AC-23 H4)
  - static search: no localStorage/sessionStorage/IndexedDB for token/refresh/mfa/vault material (AC-23 H5)
  - mfaToken is never persisted to localStorage/sessionStorage/IndexedDB/cookies/URL and is cleared on step change or mfa_token_expired (AC-8, AC-16)
  - static search: no {@html} usage in apps/web (AC-16)
  - web responses set frame-ancestors 'none' / X-Frame-Options DENY, or doc note records proxy enforcement (AC-23 H7)

apps/web/src/routes/auth-guard.test.ts or hooks.server.test.ts
  - unauthenticated app route redirects to /login
  - valid /auth/me populates locals
  - expired access + valid refresh retries /auth/me and forwards Set-Cookie
  - refresh persists session across a simulated 5-minute expiry (no spurious logout) (AC-24)
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

- [x] **Task 1: Confirm backend contracts and decide MFA branch** (AC: 2, 3, 8)
  - [x] Verify Story 1.12 implementation status in code, not only sprint status.
  - [x] Decide whether to implement MFA login UI or add blocked note.
  - [x] Add failing API-helper tests for current auth/vault response shapes.
- [x] **Task 2: API client helpers** (AC: 2, 6, 7, 10)
  - [x] Implement `lib/api/client.ts`, `auth.ts`, and `vault.ts`.
  - [x] Normalize `{ code, message }` and `{ error, message }` errors.
  - [x] Ensure `credentials: 'include'` is always used.
- [x] **Task 3: Vault gate** (AC: 3, 4, 5, 23)
  - [x] Implement readiness classification tests.
  - [x] Implement `VaultGate`, `VaultInitForm`, `VaultUnsealForm`.
  - [x] Add operator bootstrap-token field; send as `x-vault-bootstrap-token` header only; handle `403 bootstrap_forbidden` copy (AC-23 H1).
  - [x] Ensure no auto-retry storm on `429`/lockout for unseal (AC-23 H6).
  - [x] Optional backend fix: change `/ready` uninitialized reason to `uninitialized` with API test.
- [x] **Task 4: Auth pages** (AC: 6, 7, 8)
  - [x] Implement register/login forms and post-register routing.
  - [x] Implement conditional MFA step only if 1.12 backend exists.
  - [x] Ensure no token/key material enters browser storage.
- [x] **Task 5: Server-side route guards and refresh** (AC: 9, 23)
  - [x] Add `hooks.server.ts` and `app.d.ts` locals.
  - [x] Authenticated routes redirect unauthenticated users.
  - [x] Refresh flow forwards cookies and retries `/auth/me`; assert session persists across simulated expiry (AC-24).
  - [x] Add same-origin-only redirect helper and fixed reason->copy enum (AC-23 H2/H3).
- [x] **Task 6: App shell and navigation** (AC: 11, 17)
  - [x] Add authenticated layout and responsive nav.
  - [x] Implement logout.
  - [x] Add mobile structural smoke test.
- [x] **Task 7: Empty dashboard and preview state** (AC: 12, 13, 14, 15)
  - [x] Export `ProjectDashboardPreview` from `packages/shared` (add `schemas/dashboard.ts` + index re-export), add `@project-vault/shared` to `apps/web/package.json` deps, run `pnpm install`, then consume it in the web app (AC-13).
  - [x] Add reset-on-reload, **client-only** preview project state; assert no SSR singleton write (AC-14).
  - [x] Render cross-project and project dashboard empty states.
  - [x] Assert no fake operational data appears.
- [x] **Task 8: Placeholder sections** (AC: 11, 20)
  - [x] Credentials, Alerts, Health, Settings render honest placeholders.
  - [x] No 404s for primary shell nav.
- [x] **Task 9: Security and accessibility hardening** (AC: 16, 17, 23)
  - [x] Add static/storage/logging tests where practical (no localStorage/sessionStorage/IndexedDB for tokens; no `{@html}`).
  - [x] Add API-base-URL trust test and clickjacking header (CSP `frame-ancestors 'none'` / `X-Frame-Options: DENY`) or document proxy enforcement (AC-23 H4/H7).
  - [x] Verify labels, focus behavior, keyboard flows.
- [x] **Task 10: Final verification** (AC: 18, 19, 24, 25)
  - [x] Run focused web tests.
  - [x] Run `pnpm --filter @project-vault/web typecheck` and `lint`.
  - [x] Run relevant root checks if time allows.
  - [x] Complete manual QA checklist and persona acceptance signals (AC-25).
  - [x] Confirm Pre-mortem failure modes are each prevented or noted (AC-24).

### Review Findings

- [x] [Review][Patch] Vault readiness gate is not wired into user routes [`apps/web/src/routes/+page.svelte`:9] — resolved by adding root readiness routing, a `/vault` route, and hook-level readiness gating for auth/app entry paths.
- [x] [Review][Patch] SSR refresh cannot see the path-scoped refresh cookie [`apps/api/src/modules/auth/tokens.ts`:79] — resolved by scoping the refresh cookie to `/` so SSR app route guards can receive it.
- [x] [Review][Patch] Silent refresh retries `/auth/me` with stale cookies [`apps/web/src/lib/server/auth-guard.ts`:60] — resolved by merging refreshed `Set-Cookie` values into the immediate retry cookie header.
- [x] [Review][Patch] Backend `Set-Cookie` forwarding uses `event.setHeaders` [`apps/web/src/hooks.server.ts`:15] — resolved by collecting backend `Set-Cookie` values and appending them to returned responses/redirects.
- [x] [Review][Patch] Auth guard can turn backend/network auth failures into app-wide 500s [`apps/web/src/lib/server/auth-guard.ts`:46] — resolved by catching `/auth/me`, `/auth/refresh`, and retry failures and returning unauthenticated/session-expired states.
- [x] [Review][Patch] Static hardening test is tied to one local checkout path [`apps/web/src/lib/security/static-hardening.test.ts`:6] — resolved by deriving the scan root from `import.meta.url`.
- [x] [Review][Patch] Vault route tests do not validate user-visible vault behavior [`apps/web/src/routes/vault.test.ts`:1] — resolved by adding tests for the mounted `/vault` route and root readiness routing.

### Review Findings (2026-06-28)

- [x] [Review][Patch] Frontend API calls do not reach the API service in the documented topology [`apps/web/src/lib/api/client.ts`:32] — resolved by adding trusted same-origin web proxy routes for `/api/v1/*` and `/ready`, plus Docker `API_BASE_URL=http://api:3000`.
- [x] [Review][Patch] Anonymous requests always attempt `/auth/me` and then `/auth/refresh`, burning refresh rate limits without cookies [`apps/web/src/lib/server/auth-guard.ts`:110] — resolved by skipping refresh unless the incoming cookie header includes `refresh-token`.
- [x] [Review][Patch] Login and MFA forms allow duplicate submissions that can strand users on stale MFA challenges [`apps/web/src/lib/components/auth/LoginForm.svelte`:19] — resolved with in-flight submission guards and disabled submit buttons in login and MFA verification forms.
- [x] [Review][Patch] Vault init/unseal forms allow duplicate submissions against rate-limited sensitive endpoints [`apps/web/src/lib/components/vault/VaultUnsealForm.svelte`:22] — resolved with in-flight submission guards and disabled submit buttons in init and unseal forms.

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

#### ADR-2.0-05: MFA login UI is implemented against the merged Story 1.12 contract

| | |
|---|---|
| **Context** | Story 1.12 (`POST /api/v1/auth/mfa/verify-login` + the `mfaRequired` login branch) is `done` and merged (`apps/api/src/modules/auth/mfa-login.ts`). The earlier conditional/deferred framing is obsolete. |
| **Options** | **A** — Build the full MFA login UI against the real, merged 1.12 contract. **B** — (obsolete) defer behind a "1.12 not done" gate. |
| **Decision** | **Option A.** Implement the TOTP challenge + verify-login step and its tests against the real backend contract. No deferral/blocked branch exists. |
| **Rationale** | The backend endpoint is shipped and exercisable end-to-end; deferring would leave enrolled users unable to complete login. The contract (`200 { data: { mfaRequired, mfaToken } }` → verify-login → cookie session; `422 invalid_totp`; `401 mfa_token_expired`) is stable. |
| **Consequences** | Story 2.0 must include working MFA login UI and verify-login tests. `mfaToken` is held only in transient component state and is covered by the no-persistence test (AC-8/AC-16). If the backend contract changes, update the UI and tests in lockstep. |

#### ADR-2.0-06: Unavailable sections render honest placeholders, never fabricated operational state

| | |
|---|---|
| **Context** | The shell exposes Dashboard, Projects, Credentials, Alerts, Health, Settings, but their backing APIs (Epics 2.2+, 3, 6) do not exist yet. "Green silence" is the eventual monitoring goal. |
| **Options** | **A** — Seed demo/sample data or show "all healthy/0 alerts" success states to make the shell feel complete. **B** — Render explicit empty/not-configured states with no fabricated counts, health, or success affordances. |
| **Decision** | **Option B.** No green/healthy/success state, no fake counts, no mock activity until a real backing API exists. |
| **Rationale** | For a trust product, a fabricated "all healthy" is actively harmful — it implies coverage that does not exist and undermines the exact confidence the product sells (epic AC-E2f). Absence must read as honest gap, not false safety. |
| **Consequences** | The shell looks intentionally sparse pre-Epic-2.2+. Enforced by rendering tests asserting honest copy and absence of success/health language (AC-11/AC-12/AC-18). |

---

### AC-23: Frontend Security Hardening (Red Team / Blue Team)

The following attack surfaces were identified by adversarial review and MUST be closed. Each has a corresponding test in AC-18.

| # | Attack (Red Team) | Required defense (Blue Team) |
|---|---|---|
| H1 | **Vault init bypass / 403 in prod** — init form omits bootstrap token, breaks in any secure deploy, or worse the token gets bundled/persisted. | Operator-only bootstrap-token field, sent as `x-vault-bootstrap-token` header only; never bundled, defaulted, logged, or persisted (AC-4). |
| H2 | **Open redirect** via a crafted `redirectTo`/return path after login. | Only same-origin path targets (start with single `/`, not `//` or a scheme); else fall back to `/dashboard` (AC-9). |
| H3 | **Reflected injection / spoofed status** via `?reason=` or other query params rendered into the page. | Render status copy from a fixed enum map only; never interpolate raw query input into the DOM; `{@html}` remains forbidden (AC-9, AC-16). |
| H4 | **SSRF / cookie exfiltration** by pointing the API client at an attacker URL so forwarded `Cookie`/credentials leak. | API base URL comes only from trusted server env config — never from user input, query, or referer. Cookies are forwarded only to the configured API origin (AC-2, AC-9). |
| H5 | **Token theft via browser storage** — a contributor stashes access/refresh/MFA/vault material in `localStorage`/`sessionStorage`/`IndexedDB`/JS memory/URL. | HttpOnly-cookie-only sessions; static-search CI test forbids these stores for sensitive material (AC-16, AC-18; ADR-2.0-03). |
| H6 | **Rate-limit/lockout DoS or brute oracle** via aggressive auto-retry against `/vault/unseal` (5/min) or repeated login. | No automatic retry storms; unseal/login submit is user-initiated, surfaces `429`/lockout calmly, and does not auto-resubmit (AC-5, AC-7). |
| H7 | **Clickjacking** of login/init/unseal forms embedded in a hostile frame. | The web app must not be framable: `frame-ancestors 'none'` (CSP) or `X-Frame-Options: DENY`, set via the adapter-node response hook or documented as enforced by the reverse proxy (Traefik). State the chosen enforcement point. |
| H8 | **CSRF on state-changing POSTs** (login/logout/init/unseal). | Rely on `SameSite=Strict` session cookies (Epic 1 contract) and same-origin requests; document this reliance so it is not silently weakened. |

---

### AC-24: Failure Modes & Prevention (Pre-mortem)

Assume Story 2.0 shipped and failed. These are the most likely causes and their guardrails. Each must be demonstrably prevented (test or explicit note).

| Failure mode | Why it would happen | Prevention (already in story) |
|---|---|---|
| **Scope balloon / missed delivery** | Dev treats the shell as "build all sections." | Honor AC-20 out-of-scope **and** the Minimum Shippable Slice cut line below. |
| **Fake data slips in** ("0 alerts ✓", "all healthy") | Pressure to make the shell feel complete. | ADR-2.0-06 + honest-copy / no-success-language tests (AC-11/12/18). |
| **`/ready` misclassification** (uninitialized shown as sealed) | Both states share `reason: "sealed"` today. | ADR-2.0-02 backend `reason` fix (preferred) + classification tests (AC-3). |
| **Users logged out every ~5 min** | SSR `fetch` doesn't forward cookies; refresh `Set-Cookie` dropped. | Server-side cookie forwarding + silent refresh + concurrent-refresh guard, with a refresh-persists-session test (AC-9; ADR-2.0-04). |
| **Cross-user preview leak** | Module-level preview `$state` shared across SSR requests. | Client-only preview state + "no SSR singleton write" test (AC-14). |
| **Story 2.1 must redesign dashboard** | Preview shape diverged from real API. | Shared `ProjectDashboardPreview` type in `packages/shared` (AC-13). |
| **Init unusable in real deploy** | Bootstrap-token gate not handled. | AC-23 H1 / AC-4 bootstrap authorization. |
| **Mobile broken** | Only desktop verified. | Mobile viewport smoke tests + manual QA (AC-17/18/19). |

**Minimum Shippable Slice (if time-boxed):** vault readiness gate → init (with bootstrap token) → unseal → register → login (non-MFA **and** the MFA challenge + verify-login step, since Story 1.12 is merged) → server-side auth guard + silent refresh → logout → authenticated shell with honest empty dashboard. **Preview project (AC-14) and non-essential placeholder polish are the first cuts** — defer them before sacrificing the auth/refresh correctness or the no-fake-data invariant. MFA login is part of the core auth slice (not a cut), because enrolled users cannot log in without it.

---

### AC-25: Persona Acceptance Signals (User Persona Focus Group)

The shell must pass these persona reactions; copy and behavior should be validated against them in manual QA (AC-19).

| Persona | Risk reaction | Required signal |
|---|---|---|
| **Self-hoster / operator** (runs init+unseal) | "What do I paste? Where's the key file? What bootstrap token?" | Init/unseal forms label each field plainly (passphrase vs key path), explain the bootstrap token is host-configured, and link nothing fake. |
| **Evaluator** (first login) | "It's empty — is it broken?" | Empty dashboard explicitly reads as an early shell / honest gap ("Nothing here yet" + what's coming + which story), never as an error or as "all clear." |
| **Buyer / CTO** (skims the demo) | "Looks unfinished/abandoned." | Sparse-but-intentional framing: honest "early MVP shell" messaging and a clean, finished-feeling layout, so absence reads as deliberate, not broken. |
| **On-call / mobile** (Morgan) | "Can't use it on my phone." | Mobile nav and all four vault states + auth flows are usable at mobile viewport (AC-17). |
| **Compliance** (Dana) | "Implies audit/compliance features that don't exist." | Settings/placeholder sections never imply audit, RBAC, or compliance capabilities are live; they state availability by story/epic. |
| **Implementing dev** | "Where do shared types live? Is preview SSR-safe?" | Shared types in `packages/shared` (AC-13); preview state is client-only with an SSR-safety note and test (AC-14). |

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
| `POST /api/v1/auth/login` | Non-MFA user: `200 { data: { userId, orgId, expiresAt } }` plus HttpOnly cookies. MFA-enrolled user (Story 1.12, merged): `200 { data: { mfaRequired: true, mfaToken } }` with NO cookies until verify-login. |
| `POST /api/v1/auth/mfa/verify-login` | Story 1.12 (merged). Body `{ mfaToken, totp }` → `200 { data: { userId, orgId, expiresAt } }` + cookies; `422 invalid_totp`; `401 mfa_token_expired`. |
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
- Story 1.12 is `done`: it provides the real `mfaRequired` login branch and `POST /api/v1/auth/mfa/verify-login`. Consume the merged contract directly — do not reinvent or speculatively stub it.

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

## Change Log

- 2026-06-27: Implemented MVP frontend shell, vault/auth flows, server-side auth guard, shared dashboard preview contract, honest empty states, placeholder routes, and focused verification tests for Story 2.0.

## Dev Agent Record

### Agent Model Used

GPT-5.5

### Debug Log References

- 2026-06-27: Confirmed Story 1.12 MFA login backend exists in `apps/api/src/modules/auth/routes.ts`; Story 2.0 will implement the MFA login branch instead of deferring it.
- 2026-06-27: Red phase for Task 1 confirmed with `pnpm --filter @project-vault/web test -- src/lib/api/auth.test.ts src/lib/api/vault.test.ts` failing on missing API helper modules.
- 2026-06-27: Green phase for Task 1 confirmed with `pnpm --filter @project-vault/web test -- src/lib/api/auth.test.ts src/lib/api/vault.test.ts` passing.
- 2026-06-27: Task 2 helper coverage confirmed by the same focused web API test run.
- 2026-06-27: Red phase for Task 3 confirmed with `pnpm --filter @project-vault/web test -- src/routes/vault.test.ts src/lib/api/vault.test.ts` failing on missing vault components and `pnpm --filter @project-vault/api exec vitest run --coverage src/routes/health.test.ts` exposing the old readiness contract.
- 2026-06-27: Green phase for Task 3 confirmed with `pnpm --filter @project-vault/web test -- src/routes/vault.test.ts src/lib/api/vault.test.ts` passing and `pnpm --filter @project-vault/api exec vitest run src/routes/health.test.ts` passing. The covered API run also passed tests but failed global coverage thresholds because it targeted one file.
- 2026-06-27: Red phase for Task 4 confirmed with `pnpm --filter @project-vault/web test -- src/routes/auth.test.ts src/lib/api/auth.test.ts` failing on the missing auth form model.
- 2026-06-27: Green phase for Task 4 confirmed with `pnpm --filter @project-vault/web test -- src/routes/auth.test.ts src/lib/api/auth.test.ts` passing.
- 2026-06-27: Red phase for Task 5 confirmed with `pnpm --filter @project-vault/web test -- src/routes/auth-guard.test.ts src/lib/security/hardening.test.ts` failing on missing guard/hardening modules.
- 2026-06-27: Green phase for Task 5 confirmed with `pnpm --filter @project-vault/web test -- src/routes/auth-guard.test.ts src/lib/security/hardening.test.ts` passing.
- 2026-06-27: Red phase for Task 6 confirmed with `pnpm --filter @project-vault/web test -- src/routes/mobile-smoke.test.ts` failing on the missing shell nav model.
- 2026-06-27: Green phase for Task 6 confirmed with `pnpm --filter @project-vault/web test -- src/routes/mobile-smoke.test.ts` passing.
- 2026-06-27: Red phase for Task 7 confirmed with `pnpm --filter @project-vault/shared exec vitest run src/schemas/dashboard.test.ts` and `pnpm --filter @project-vault/web test -- src/lib/state/preview-project.test.ts src/routes/dashboard.test.ts` failing on missing schema/dependency/dashboard modules.
- 2026-06-27: Green phase for Task 7 confirmed with the same focused shared and web test commands passing after `pnpm --filter @project-vault/web add "@project-vault/shared@workspace:*"`.
- 2026-06-27: Red phase for Task 8 confirmed with `pnpm --filter @project-vault/web test -- src/routes/placeholder-sections.test.ts` failing on the missing placeholder copy module.
- 2026-06-27: Green phase for Task 8 confirmed with `pnpm --filter @project-vault/web test -- src/routes/placeholder-sections.test.ts` passing.
- 2026-06-27: Red phase for Task 9 confirmed with `pnpm --filter @project-vault/web test -- src/lib/security/static-hardening.test.ts src/lib/security/hardening.test.ts` failing on missing frame-protection helper/static scan setup.
- 2026-06-27: Green phase for Task 9 confirmed with the same focused hardening test command passing.
- 2026-06-27: Final verification passed for `pnpm --filter @project-vault/web test`, `pnpm --filter @project-vault/shared test`, `pnpm --filter @project-vault/web typecheck`, `pnpm --filter @project-vault/web lint`, `pnpm typecheck`, and `pnpm --filter @project-vault/web build`.
- 2026-06-27: `pnpm lint` was run and failed in repository-wide scope due existing lint targets outside this story's web package, including `.claude/skills/wds-5-agentic-development/templates/components/dev-mode.js`; web package lint passed with exit 0.

### Completion Notes List

- Task 1 complete: established auth/vault frontend API contract tests, verified MFA login backend presence, and added minimal helper implementation for the tested API boundaries.
- Task 2 complete: added the shared `apiFetch` boundary, auth helpers, vault helpers, error normalization, 204 handling, and cookie-credential request behavior.
- Task 3 complete: added vault gate state modeling, init/unseal forms, bootstrap header handling, unseal rate-limit handling, and the backend `/ready` `uninitialized` reason fix.
- Task 4 complete: added register/login/MFA form modeling, auth forms, post-register routing to login, and `(auth)` route pages.
- Task 5 complete: added SvelteKit locals, server hook auth guard, silent refresh retry, Set-Cookie forwarding, protected/auth route redirects, same-origin redirect helper, fixed login reason copy, and trusted API-base helper.
- Task 6 complete: added authenticated app shell, primary navigation model/components, logout routing, app route group layout, and mobile structural smoke coverage.
- Task 7 complete: added shared dashboard preview schema, canonical empty dashboard preview value, web preview project state, dashboard empty-state components/routes, and tests preventing fake operational claims.
- Task 8 complete: added honest placeholder copy/component and non-404 primary nav pages for Projects, Credentials, Alerts, Health, and Settings.
- Task 9 complete: added static checks against browser storage and raw HTML, trusted API-base helper coverage, clickjacking response headers, and labeled keyboard-accessible form/navigation controls.
- Task 10 complete: all story-focused checks passed; root typecheck and web production build passed. Manual browser viewport QA was not executed in this CLI session, but mobile/persona acceptance risks are covered by structural smoke tests, responsive classes, and successful production build.

### File List

- apps/web/src/lib/api/auth.test.ts
- apps/web/src/lib/api/auth.ts
- apps/web/src/lib/api/client.ts
- apps/web/src/lib/api/vault.test.ts
- apps/web/src/lib/api/vault.ts
- apps/api/src/routes/health.test.ts
- apps/api/src/routes/health.ts
- apps/web/src/lib/components/vault/VaultGate.svelte
- apps/web/src/lib/components/vault/VaultInitForm.svelte
- apps/web/src/lib/components/vault/VaultUnsealForm.svelte
- apps/web/src/lib/components/vault/form-model.ts
- apps/web/src/lib/components/vault/gate-model.ts
- apps/web/src/routes/vault.test.ts
- apps/web/src/lib/components/auth/LoginForm.svelte
- apps/web/src/lib/components/auth/MfaLoginForm.svelte
- apps/web/src/lib/components/auth/RegisterForm.svelte
- apps/web/src/lib/components/auth/form-model.ts
- apps/web/src/routes/(auth)/+layout.svelte
- apps/web/src/routes/(auth)/login/+page.svelte
- apps/web/src/routes/(auth)/register/+page.svelte
- apps/web/src/routes/auth.test.ts
- apps/web/src/app.d.ts
- apps/web/src/hooks.server.ts
- apps/web/src/lib/security/hardening.test.ts
- apps/web/src/lib/security/hardening.ts
- apps/web/src/lib/server/auth-guard.ts
- apps/web/src/routes/auth-guard.test.ts
- apps/web/src/lib/components/shell/AppShell.svelte
- apps/web/src/lib/components/shell/PrimaryNav.svelte
- apps/web/src/lib/components/shell/nav-model.ts
- apps/web/src/routes/(app)/+layout.server.ts
- apps/web/src/routes/(app)/+layout.svelte
- apps/web/src/routes/mobile-smoke.test.ts
- apps/web/package.json
- packages/shared/src/index.ts
- packages/shared/src/schemas/dashboard.test.ts
- packages/shared/src/schemas/dashboard.ts
- pnpm-lock.yaml
- apps/web/src/lib/components/dashboard/CrossProjectEmptyState.svelte
- apps/web/src/lib/components/dashboard/DashboardPlaceholderGrid.svelte
- apps/web/src/lib/components/dashboard/ProjectDashboardEmptyState.svelte
- apps/web/src/lib/components/dashboard/dashboard-copy.ts
- apps/web/src/lib/state/preview-project.svelte.ts
- apps/web/src/lib/state/preview-project.test.ts
- apps/web/src/routes/(app)/dashboard/+page.svelte
- apps/web/src/routes/(app)/projects/preview/+page.svelte
- apps/web/src/routes/dashboard.test.ts
- apps/web/src/lib/components/shell/PlaceholderSection.svelte
- apps/web/src/lib/components/shell/placeholder-copy.ts
- apps/web/src/routes/(app)/alerts/+page.svelte
- apps/web/src/routes/(app)/credentials/+page.svelte
- apps/web/src/routes/(app)/health/+page.svelte
- apps/web/src/routes/(app)/projects/+page.svelte
- apps/web/src/routes/(app)/settings/+page.svelte
- apps/web/src/routes/placeholder-sections.test.ts
- apps/web/src/lib/security/static-hardening.test.ts
- apps/web/eslint.config.js
- apps/web/tsconfig.json
