# Story 18.2: Absolute URLs for Shared and Generated Links

Status: review

<!-- Note: Validation is optional. Run validate-create-story for quality check before dev-story. -->

## Story

As a user who shares a credential link with a teammate,
I want the link the app shows/copies to be a complete, absolute URL (with the site's domain and scheme),
so that I can paste it anywhere and it still works, instead of getting a bare relative path that's meaningless outside the app.

## Product Surface Contract

| Field | Value |
|-------|-------|
| **Surface scope** | `web` |
| **Evaluator-visible** | yes |
| **Linked UI story** (if API-only) | N/A |
| **Honest placeholder AC** (if UI deferred) | N/A |
| **Persona journey** | See below |

### Persona journey stub

Morgan-member shares a credential field with a colleague and copies the generated link. The link shown/copied reads `https://vault.example.com/shares/<token>`, not `/shares/<token>` — Morgan can paste it into Slack/email and it resolves correctly without manual editing.

## Acceptance Criteria

1. The share link displayed/copied on the credential detail page (`apps/web/src/routes/(app)/projects/[projectId]/credentials/[credentialId]/+page.svelte:1344-1352`, currently `resolve(`/shares/${token}`)` / `resolve(`/external-shares/${token}`)`) is rendered as a full absolute URL (scheme + host + path), not a relative path.
2. The absolute URL is built using this app's existing trusted-origin resolution convention — for server-rendered contexts, the existing `WEB_BASE_URL` env var pattern already used server-side (`apps/api/src/config/env.ts:584`, consumed via `stripTrailingSlashes(env.WEB_BASE_URL)` in `apps/api/src/modules/auth/recovery.ts:111`, `apps/api/src/modules/platform-admin/service.ts:417`, `apps/api/src/modules/invitations/routes.ts:126`); for client-side/SvelteKit-rendered contexts, the request's actual resolved origin (e.g. `url.origin` in a `+page.server.ts` load/action). Follow whatever this app's server already does to trust/derive an origin behind its production reverse-proxy setup (if any) rather than introducing a new precedence scheme for this one feature.
3. A shared helper (e.g. in `packages/shared` or a small `apps/web` utility) centralizes "build absolute app URL from path" so this isn't reimplemented ad hoc; the credential-share link builder uses it.
4. Audit other places the app displays or copies a link intended for use outside the current page/session (e.g. public status page URL if shown to the user, invitation links, any "copy link" affordance) and apply the same absolute-URL treatment where a relative path is currently shown. Note in Dev Agent Record which spots were checked and their disposition (fixed / deferred with reason / not applicable) so the audit's coverage is visible to a reviewer.
5. If origin resolution fails or produces an empty/malformed value (e.g. `WEB_BASE_URL` unset or misconfigured in a given environment), the app must not silently render a broken "https://undefined/shares/..." link — fail loudly in a way that's caught by tests/CI (e.g. env validation) rather than surfacing a broken link to the end user.
6. If a "copy link" control exists alongside the displayed link, it continues to give its existing confirmation feedback (e.g. toast/checkmark) for the now-absolute URL value — copy behavior itself is unchanged by this story, just the value being copied.
7. Existing/updated tests cover: the rendered link is absolute (starts with `http://` or `https://`), matches the deployment's configured base URL, and the path/token portion is unchanged from current behavior.
8. No change to the underlying route structure, token generation, or share semantics — this is display/link-construction only.

## Tasks / Subtasks

- [x] Task 1: Add shared absolute-URL builder helper (AC: 3)
- [x] Task 2: Update credential share link display/copy to use it (AC: 1, 2)
- [x] Task 3: Audit and fix other relative-link-shown-as-shareable spots (AC: 4)
- [x] Task 4: Tests (AC: 5)

## Dev Notes

- Current relative-link bug confirmed at `apps/web/src/routes/(app)/projects/[projectId]/credentials/[credentialId]/+page.svelte:1344-1352`: `resolve(`/shares/${lastCreatedShareToken}`)` / `resolve(`/external-shares/${lastCreatedShareToken}`)` — `resolve()` from SvelteKit only ever returns an app-relative path, it does not know the origin.
- `WEB_BASE_URL` (`apps/api/src/config/env.ts:584`, default `http://localhost:5173`) is the existing convention for absolute links generated **server-side** (recovery emails, platform-admin, invitations). This story's share link is generated **client-side** after a POST response, on a page the user is already viewing — prefer deriving the origin from the current page/request (`url.origin` from the load function, passed down as page data) over a hardcoded env var, since it will naturally match whatever domain the user is actually on (custom domains, preview environments) without needing `WEB_BASE_URL` kept in sync. Use `WEB_BASE_URL` only for genuinely server-only contexts (e.g. if a future story emails the share link, per Story 18.6).
- The API's `credential-share-created` notification template (`apps/api/src/notifications/templates/credential-share-created.ts`) deliberately does not embed the token/link in the email body (Story 17.1 AC-10) — do not change that in this story; it's out of scope (email delivery for shares is Story 18.6).
- No shared "build absolute URL" utility currently exists — check `packages/shared/src/` for the best home before adding a new one; keep it framework-agnostic if placed there (no `$app/paths` import) so it's reusable from `apps/api` too if needed later.

### Project Structure Notes

- New helper likely lands in `packages/shared/src/utils/` or `apps/web/src/lib/utils/` depending on whether it needs SvelteKit APIs — confirm by checking existing url-building utilities in both locations before deciding.

### References

- [Source: apps/web/src/routes/(app)/projects/[projectId]/credentials/[credentialId]/+page.svelte]
- [Source: apps/api/src/config/env.ts#WEB_BASE_URL]
- [Source: apps/api/src/modules/auth/recovery.ts]
- Product surface rules: [Source: _bmad-output/implementation-artifacts/product-surface-contract.md]

## Dev Agent Record

### Agent Model Used

Claude Sonnet 5 (claude-sonnet-5)

### Debug Log References

- `packages/shared`: `npx vitest run` — 20 files / 192 tests passed.
- `apps/web`: `npx vitest run` (full suite) — 221 files / 1862 tests passed.
- `apps/web`: `npx tsc --noEmit -p .` — clean.
- `apps/web` and `packages/shared`: `npx eslint` on all changed files — clean (0 errors/warnings).

### Completion Notes List

- **AC-3 (Task 1):** Added `buildAbsoluteUrl(origin, path)` in `packages/shared/src/utils/absolute-url.ts` (exported from the package index), framework-agnostic so it's reusable from `apps/api` later. Validates the origin is a well-formed `http`/`https` URL and throws otherwise (backs AC-5); normalizes a missing leading slash on the path and a trailing slash on the origin. TDD red-green: `absolute-url.test.ts` written first (failed on missing module), then implemented to green.
- **AC-1/AC-2 (Task 2):** Credential detail page's share-link `<code>` block (`+page.svelte`) now renders `buildAbsoluteUrl(data.origin, ...)` instead of the previous `resolve(...)` relative path. `data.origin` is supplied by `+page.server.ts`'s `load` via a new `resolveTrustedOrigin(url)` helper using the request's own `url.origin` (per Dev Notes: client-side-generated link on a page the user is already viewing, so it naturally matches custom domains/preview environments — `WEB_BASE_URL` stays reserved for genuinely server-only contexts like emails, unchanged). `origin` is threaded through both the success path and the existing 404/503 empty-result branches so it's always present.
- **AC-4 (Task 3) — audit of other "copy link for outside use" spots:**
  - **Public status page** (`apps/web/.../status-page/+page.svelte`) — **fixed**. Was already absolute but built ad hoc via `window.location.origin` (client-only, breaks under SSR/no-JS, duplicated the same logic this story centralizes). Now uses the same `data.origin` (added to that route's `+page.server.ts` load) + `buildAbsoluteUrl`.
  - **Invitation accept link** — **not applicable**. Generated and emailed entirely server-side (`apps/api/src/modules/invitations/routes.ts:126`, `WEB_BASE_URL` + `stripTrailingSlashes`, already absolute); the web app has no UI that displays or lets a user copy this link — it's only ever consumed by the recipient clicking the emailed link.
  - **Recovery link** (`apps/api/src/modules/auth/recovery.ts`, `platform-admin/service.ts`) — **not applicable**, same reasoning as invitations: server-only, emailed, already absolute via `WEB_BASE_URL`.
  - **Revealed secret value "Copy" button** and **machine-user credential value copy** — **not applicable**: these copy the secret's raw value, not a link intended for use outside the app.
  - **`/shares/[token]` and `/external-shares/[token]` landing pages** — **not applicable**: these are the pages a recipient opens after clicking the link; they don't themselves display/copy a link.
- **AC-5:** `buildAbsoluteUrl` throws on an empty/undefined/malformed/non-http(s) origin instead of silently interpolating it into a link (unit-tested). Additionally, `+page.server.ts`'s `resolveTrustedOrigin` guards the credential-detail load itself, failing the load (HTTP 500) rather than ever handing a broken origin down to the page — covered by a server-load test that forces an empty `url.origin`.
- **AC-6:** No "copy" affordance exists next to the credential-share link (it's copy-manually via triple-click/select, same as before) — unchanged by this story. The public status page's existing "Copy"/"Copied!" button and toast-equivalent feedback are unchanged; only the URL value it copies became centrally built (still verified end-to-end in `status-page-admin.test.ts`).
- **AC-7:** New/updated tests assert the rendered credential-share and status-page links are full absolute URLs (`https://vault.example.com/...`) matching a fixed, non-jsdom-default origin (proving it isn't just accidentally matching jsdom's default `location`), with the token/path portion unchanged from prior behavior.
- **AC-8:** No route, token-generation, or share-semantics changes — display/link-construction only, confirmed by the untouched API layer and unchanged share-creation call sites.

### File List

- `packages/shared/src/utils/absolute-url.ts` (new)
- `packages/shared/src/utils/absolute-url.test.ts` (new)
- `packages/shared/src/index.ts` (export the new helper)
- `apps/web/src/routes/(app)/projects/[projectId]/credentials/[credentialId]/+page.server.ts` (add trusted `origin` to page data, both success and error branches)
- `apps/web/src/routes/(app)/projects/[projectId]/credentials/[credentialId]/+page.svelte` (use `buildAbsoluteUrl(data.origin, ...)` for the share link instead of `resolve(...)`)
- `apps/web/src/routes/(app)/projects/[projectId]/credentials/[credentialId]/credential-detail-page.server.test.ts` (origin propagation + fail-loud tests)
- `apps/web/src/routes/(app)/projects/[projectId]/credentials/[credentialId]/credential-detail-page.test.ts` (absolute-URL assertions + AC-5 render-time throw test)
- `apps/web/src/routes/(app)/projects/[projectId]/status-page/+page.server.ts` (add `origin` to page data)
- `apps/web/src/routes/(app)/projects/[projectId]/status-page/+page.svelte` (centralize `publicUrl` via `buildAbsoluteUrl(data.origin, ...)` instead of ad hoc `window.location.origin`)
- `apps/web/src/routes/(app)/projects/[projectId]/status-page/status-page-server-load.test.ts` (origin propagation test)
- `apps/web/src/routes/status-page-admin.test.ts` (updated assertions to a fixed origin instead of `window.location.origin`)

## Change Log

- 2026-07-30: Implemented all 4 tasks / 8 ACs via bmad-dev-story, TDD red-green throughout. Full `apps/web` suite (221 files/1862 tests) and `packages/shared` suite (20 files/192 tests) green; `apps/web` typecheck and eslint on all changed files clean. Status: ready-for-dev → review.
