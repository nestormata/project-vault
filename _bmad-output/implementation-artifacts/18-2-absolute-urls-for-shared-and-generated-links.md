# Story 18.2: Absolute URLs for Shared and Generated Links

Status: ready-for-dev

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

- [ ] Task 1: Add shared absolute-URL builder helper (AC: 3)
- [ ] Task 2: Update credential share link display/copy to use it (AC: 1, 2)
- [ ] Task 3: Audit and fix other relative-link-shown-as-shareable spots (AC: 4)
- [ ] Task 4: Tests (AC: 5)

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

### Debug Log References

### Completion Notes List

### File List
