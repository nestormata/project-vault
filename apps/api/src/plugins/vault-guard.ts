import type { FastifyRequest } from 'fastify/types/request.js'
import type { FastifyReply } from 'fastify/types/reply.js'
import fp from 'fastify-plugin'
import type { FastifyApp } from '../lib/fastify-app.js'
import { getVaultStatus } from '../modules/vault/key-service.js'

/** Normalize path: strip query string, remove trailing slash (except root "/"). */
function normalizePath(rawUrl: string): string {
  const path = rawUrl.split('?')[0] ?? rawUrl
  if (path.length > 1 && path.endsWith('/')) {
    return path.slice(0, -1)
  }
  return path
}

// Exact path+method pairs that bypass the vault guard
const VAULT_GUARD_ALLOWLIST = new Set([
  'GET /health',
  'GET /ready',
  'POST /api/v1/vault/init',
  'POST /api/v1/vault/unseal',
  'POST /api/v1/auth/register',
  'POST /api/v1/auth/login',
  'POST /api/v1/auth/refresh',
])

async function vaultGuard(fastify: FastifyApp): Promise<void> {
  fastify.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    const path = normalizePath(req.url)
    const routeKey = `${req.method} ${path}`
    if (VAULT_GUARD_ALLOWLIST.has(routeKey)) return

    const vaultStatus = getVaultStatus()
    if (vaultStatus !== 'unsealed') {
      return reply.status(503).send({ status: 'sealed', message: 'Vault not initialized' })
    }
  })
}

// fastify-plugin breaks encapsulation: this onRequest hook must apply to every route
// in the app (including ones registered as sibling plugins and the 404 handler),
// not just within vaultGuard's own encapsulation context.
export const vaultGuardPlugin = fp(vaultGuard, { name: 'vault-guard' })
