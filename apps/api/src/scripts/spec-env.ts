/**
 * The environment the committed-OpenAPI generator (`generate-spec.ts`) boots `createApp()` with.
 * It must run BEFORE `app.js` (and so `config/env.ts`) is imported.
 *
 * - `DATABASE_URL`: `config/env.ts` requires it with no default, but route registration never
 *   opens a connection (`getDb()` connects lazily), so any well-formed, non-superuser URL works.
 *   No password is included, so it never looks like a credential to secret scanners. The
 *   admin-pool URL is deliberately NOT defaulted here: admin-pool-boundary.test.ts keeps that
 *   variable's name to lib/db.ts and config/env.ts; callers supply it.
 * - `RELEASE_VERSION` (Story 9.10): removed so `info.version` is the dev fallback and the
 *   committed spec stays byte-identical wherever it is regenerated.
 * - `VAULT_EXTENSIONS_PACKAGE` and `VAULT_EXTENSIONS_REQUIRED` (Story 68.8 AC-15): removed so a
 *   developer shell with an extension configured can neither leak extension routes into PV's
 *   committed spec nor make the generator fail. Story 68-14's runtime route audit reuses this for
 *   its no-extension run.
 */
export function prepareSpecGenerationEnv(env: NodeJS.ProcessEnv): void {
  env['DATABASE_URL'] ??= 'postgresql://vault_app@localhost:5432/project_vault'
  delete env['RELEASE_VERSION']
  delete env['VAULT_EXTENSIONS_PACKAGE']
  delete env['VAULT_EXTENSIONS_REQUIRED']
}
