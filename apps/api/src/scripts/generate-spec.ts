import { writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const outPath = resolve(__dirname, '../../../../packages/shared/openapi.json')

// config/env.ts requires DATABASE_URL with no default (real deployments must set it
// explicitly), but route registration never opens a connection — @project-vault/db's
// getDb() only connects lazily on first query, and this script only registers routes and
// reads their attached schemas. Any well-formed, non-superuser URL satisfies validation
// without a reachable database.
process.env.DATABASE_URL ??= 'postgresql://vault_app:generate-spec@localhost:5432/project_vault'

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
