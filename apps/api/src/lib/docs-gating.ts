/**
 * Story 9.3 D5 — whether Swagger UI (`GET /api/v1/docs`) and the live spec route
 * (`GET /api/v1/openapi.json`) should be registered at all.
 *
 * Deliberately an allowlist (`enableApiDocs === true || nodeEnv === 'development' || nodeEnv ===
 * 'test'`), not a `nodeEnv !== 'production'` negation: the allowlist form only enables docs for
 * the two specific values this codebase's own tooling actually sets (`development` locally,
 * `test` in CI/vitest) and defaults closed for every other value, including anything
 * unrecognized (a typo, an unset variable, a differently-cased value). A self-hosted secrets
 * product should not, by default, expose a fully browsable map of every authenticated route and
 * its exact request/response schema.
 */
export function docsEnabled(input: { enableApiDocs: boolean; nodeEnv: string }): boolean {
  return input.enableApiDocs === true || input.nodeEnv === 'development' || input.nodeEnv === 'test'
}
