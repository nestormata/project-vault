import { writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareSpecGenerationEnv } from './spec-env.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const outPath = resolve(__dirname, '../../../../packages/shared/openapi.json')

// Must run before app.js (and config/env.ts) is imported: a placeholder DATABASE_URL, no
// RELEASE_VERSION (Story 9.10 determinism) and no extension settings (Story 68.8 AC-15: the
// committed spec stays PV-only). See spec-env.ts for the full rationale.
prepareSpecGenerationEnv(process.env)

const { createApp } = await import('../app.js')

// @fastify/swagger (registered in app.ts with @fastify/type-provider-zod's
// jsonSchemaTransform) already derives a complete OpenAPI document from the Zod schemas
// attached to every real secureRoute()/fastify.route() registration — so booting the actual
// app and reading it back is the only way this spec can't silently drift from the real route
// surface the way a hand-maintained constant did.
const app = await createApp({ logger: false })
await app.ready()
const document = app.swagger()
writeFileSync(outPath, JSON.stringify(document, null, 2) + '\n')
await app.close()

// Some Fastify plugins retain event-loop handles after a successful close under Node 24. The
// generator has completed its synchronous write and awaited the app shutdown, so terminate the
// one-shot process explicitly instead of leaving Turbo's generate-spec task hanging indefinitely.
process.exit(0)
