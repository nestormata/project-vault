# Security notes — `@project-vault/agent`

## Cache-encryption cross-release synchronization checklist (Story 8-6 AC-10)

The AES-256-GCM/HKDF envelope used to encrypt the offline secret cache
(`~/.project-vault/cache.json`) is intentionally **duplicated, not shared**, across three
independently-versioned artifacts:

| # | Location | Role |
|---|---|---|
| 1 | `packages/crypto/src/aes.ts` (+ `kdf.ts`) | Server-side reference implementation. Private workspace package, never published. |
| 2 | `packages/agent/src/cache-crypto.ts` | Offline-agent implementation. Deliberately self-contained (uses `node:crypto` directly, no dependency on `packages/crypto`) because `@project-vault/agent` must be installable standalone outside this monorepo (Story 7.2 D11). |
| 3 | `packages/vault-action/dist/index.js` | A bundled build artifact: `packages/vault-action` depends on `@project-vault/agent` and bundles it (via its build step) into a single self-contained `dist/index.js`, since a GitHub Action runner never has monorepo `node_modules` resolution available. This is a *compiled snapshot* of #2 at whatever commit it was last built from — editing #2 does **not** change this file until it is rebuilt. |

There is no automated build-graph dependency-change-detector tying a fix in one copy to a mandatory
rebuild of the other two — that is a larger investment than any Epic 7/8 story has scoped. Instead,
this is a **checked manual process**: every security-relevant change to any of the three locations
above must be accompanied by a comment (already present at each location, cross-referencing this
file) and the following steps before the change can be considered done:

1. **Re-run the cross-compatibility test** —
   `apps/api/src/__tests__/agent-crypto-cross-compat.test.ts` — the only test that proves copies #1
   and #2 stay byte-for-byte interoperable (same algorithm, IV length, envelope shape, and derived
   key bytes). It runs in `apps/api` because that is the only workspace allowed to depend on both
   `@project-vault/crypto` and `@project-vault/agent`.
2. **Port the fix into whichever of #1/#2 wasn't the origin of the change**, if the change is
   security-relevant to both (e.g. an algorithm, IV-length, or envelope-shape change). A change
   scoped to something #1 doesn't share with #2 (or vice versa) does not require this step —
   use judgment, but default to porting when in doubt.
3. **Rebuild `packages/vault-action/dist/`** — `pnpm --filter @project-vault/vault-action build` —
   whenever #2 changes. `scripts/check-vault-action-dist-fresh.ts` (wired into `make ci`) verifies
   the committed `dist/` is not stale relative to `src/`, but that check only catches an unbuilt
   `dist/` *before merge*; it does not retroactively fix an already-tagged release.
4. **Cut a `vault-action` re-tag/release** once `dist/` is rebuilt, so CI consumers pinned to the
   mutable `vault-action-v1` tag (see Story 7.3 D7 on why that tag's branch-protection gate on
   `main` matters) actually receive the fix. Editing source and rebuilding `dist/` alone does not
   reach anyone already using the released action until a new tag is pushed.

This is a documentation/process control, not new automation. It does not de-duplicate the three
copies — that remains an accepted, larger-scoped refactor for a future story if ever undertaken.
