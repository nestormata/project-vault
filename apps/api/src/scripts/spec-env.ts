/**
 * The environment the committed-OpenAPI generator (`generate-spec.ts`) boots `createApp()` with.
 * It must run BEFORE `app.js` (and so `config/env.ts`) is imported.
 *
 * - `RELEASE_VERSION` (Story 9.10): removed so `info.version` is the dev fallback and the
 *   committed spec stays byte-identical wherever it is regenerated.
 * - `VAULT_EXTENSIONS_PACKAGE` and `VAULT_EXTENSIONS_REQUIRED` (Story 68.8 AC-15): removed so a
 *   developer shell with an extension configured can neither leak extension routes into PV's
 *   committed spec nor make the generator fail. Story 68-14's runtime route audit reuses this for
 *   its no-extension run.
 */
export function prepareSpecGenerationEnv(env: NodeJS.ProcessEnv): void {
  delete env['RELEASE_VERSION']
  delete env['VAULT_EXTENSIONS_PACKAGE']
  delete env['VAULT_EXTENSIONS_REQUIRED']
}
