import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeFileSync } from 'node:fs'
import { prepareSpecGenerationEnv } from './spec-env.js'
import {
  SPEC_USAGE,
  SpecLoadError,
  SpecUsageError,
  generateComposedSpec,
  parseSpecArgs,
  resolveOutPath,
  writeFileAtomic,
} from './spec-composed.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const outPath = resolve(__dirname, '../../../../packages/shared/openapi.json')

// config/env.ts requires DATABASE_URL with no default (real deployments must set it
// explicitly), but route registration never opens a connection — @project-vault/db's
// getDb() only connects lazily on first query, and this script only registers routes and
// reads their attached schemas. Any well-formed, non-superuser URL satisfies validation
// without a reachable database — no password is required, so none is included (avoids
// looking like a credential to secret-scanning tools).
//
// env.ts also requires the admin-pool connection var, which is deliberately NOT given a
// fallback here: admin-pool-boundary.test.ts enforces that no file outside lib/db.ts and
// config/env.ts (plus tests) references that env var by name, to keep the admin-pool
// credential's usage auditable at those two sites only. Callers of this script (the
// Makefile's ci-inner target, CI's job-level env) are expected to supply it externally.
process.env.DATABASE_URL ??= 'postgresql://vault_app@localhost:5432/project_vault'

// Story 68.14 AC-3: `--extension <package> --out <path>` writes CentralizeMe's composed spec to
// <path>; without flags this script writes PV's own committed spec as before. Usage errors are
// answered (exit 2) before anything is imported or booted.
let args: ReturnType<typeof parseSpecArgs>
let composedOut: string | undefined
try {
  args = parseSpecArgs(process.argv.slice(2))
  if (args.mode === 'composed') composedOut = resolveOutPath(args.out, outPath)
} catch (error) {
  if (!(error instanceof SpecUsageError)) throw error
  process.stderr.write(`${error.message}\n${SPEC_USAGE}\n`)
  process.exit(2)
}

// Must run before app.js (and config/env.ts) is imported: no RELEASE_VERSION (Story 9.10
// determinism) and no extension settings (Story 68.8 AC-15: the committed spec stays PV-only; in
// composed mode the package comes from the flag, never from the shell). See spec-env.ts.
prepareSpecGenerationEnv(process.env)

const { createApp } = await import('../app.js')

if (args.mode === 'composed' && composedOut) {
  const { getExtensionStatus } = await import('../extensions/loader.js')
  try {
    const text = await generateComposedSpec(args, { createApp, getExtensionStatus })
    // Only after a fully successful boot: a failure leaves the old --out untouched.
    writeFileAtomic(composedOut, text)
    process.stdout.write('generate-spec: composed OpenAPI document written\n')
    process.exit(0)
  } catch (error) {
    const reason = (error as { reason?: unknown }).reason
    const known = error instanceof SpecLoadError || typeof reason === 'string'
    const label = typeof reason === 'string' ? `${reason}: ` : ''
    process.stderr.write(
      `generate-spec: ${known ? `${label}${(error as Error).message}` : 'composed generation failed'}\n`
    )
    process.exit(1)
  }
}

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
