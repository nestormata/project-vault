import { eq } from 'drizzle-orm'
import { organizations, orgSsoDomains } from '@project-vault/db/schema'
import { DomainLookupRequestSchema, DomainLookupResponseSchema } from '@project-vault/shared'
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { FastifyApp } from '../../lib/fastify-app.js'
import { ApiErrorSchema } from '../../lib/api-contracts.js'
import { secureRoute } from '../../lib/secure-route.js'
import { validationError } from '../../lib/route-helpers.js'
import { getAdminDb } from '../../lib/db.js'
import { env } from '../../config/env.js'
import { findAuthStrategy } from './strategies.js'
import { getCompiledThemes } from '../theming/service.js'

const NO_SSO = { ssoRequired: false as const }

type DomainLookupThemeRow = { providerName: string; defaultThemeName: string | null }

/**
 * Story 14.4 AC-2/AC-2a: extracts the lowercased label after the first `@`. Deliberately does
 * NOT assume a validated email shape — no `@`, or an empty domain portion, resolves to `null`
 * (treated as "no mapping", never a validation error). Only the exact full-string label after
 * `@` is used — never a substring/wildcard match (AC-1a/AC-1c), so `notacme.com` never matches a
 * stored `acme.com` row and `mail.acme.com` never matches a stored `acme.com` row.
 */
export function extractDomain(email: string): string | null {
  const at = email.indexOf('@')
  if (at < 0 || at === email.length - 1) return null
  const domain = email
    .slice(at + 1)
    .trim()
    .toLowerCase()
  return domain.length > 0 ? domain : null
}

// Story 16.4 Task 6.2: joins organizations.defaultThemeName onto the same domain-mapping row this
// handler already reads — no second query, no second pre-auth lookup call (AC-3).
async function lookupDomain(domain: string): Promise<DomainLookupThemeRow | null> {
  const rows = await getAdminDb()
    .select({
      providerName: orgSsoDomains.providerName,
      defaultThemeName: organizations.defaultThemeName,
    })
    .from(orgSsoDomains)
    .innerJoin(organizations, eq(orgSsoDomains.orgId, organizations.id))
    .where(eq(orgSsoDomains.domain, domain))
    .limit(1)
  return rows[0] ?? null
}

// Story 16.4 Task 6.2 — resolves `theme` from the already-fetched row: `getCompiledThemes()` is
// read exactly once (a single in-memory snapshot), so a concurrent 16.1 reload can never produce
// an internally-inconsistent response (Pre-Mortem scenario #2 — "reload race" regression). Both-
// or-neither: returns the full `{ name, css }` pair for a currently-valid theme, or `null` — never
// a bare `name` with no matching `css`.
function resolveDomainLookupTheme(
  defaultThemeName: string | null
): { name: string; css: string } | null {
  if (defaultThemeName === null) return null
  const compiled = getCompiledThemes().find((theme) => theme.name === defaultThemeName)
  return compiled ? { name: compiled.name, css: compiled.css } : null
}

async function handleDomainLookup(request: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  const parsed = DomainLookupRequestSchema.safeParse(request.body)
  // Schema only requires a non-empty string — a malformed/no-`@` email never fails this parse
  // (AC-2a); an entirely missing/wrong-typed `email` field is the one case that is a genuine
  // client-integration error, not a login-flow edge case, so it alone gets a 422.
  if (!parsed.success) return reply.status(422).send(validationError(parsed.error, 'body'))

  const domain = extractDomain(parsed.data.email)
  if (!domain) return reply.status(200).send(NO_SSO)

  try {
    const row = await lookupDomain(domain)
    if (!row) return reply.status(200).send(NO_SSO)

    // Story 16.4 Task 6.2: theme resolution is independent of SSO-strategy resolution — both are
    // read from the same row/join, but a domain mapped to an org with no currently-registered
    // strategy can still carry a resolvable theme (and vice versa). The `theme` key is omitted
    // entirely (not sent as an explicit `null`) when there is nothing to resolve, keeping the
    // existing miss-response shape (AC-9a) byte-identical for the no-org-default case.
    const theme = resolveDomainLookupTheme(row.defaultThemeName)
    const themeField = theme ? { theme } : {}

    // AC-1b: fail open if the stored provider isn't currently registered (extension failed to
    // load / was unloaded since the mapping was created).
    const strategy = findAuthStrategy(row.providerName)
    if (!strategy) return reply.status(200).send({ ...NO_SSO, ...themeField })

    return reply
      .status(200)
      .send({ ssoRequired: true, providerName: strategy.providerName, ...themeField })
  } catch {
    // AC-3/AC-3b: any DB error (transient or otherwise) resolves to the same "no mapping"
    // response — never an unhandled 500. Structurally identical to the miss path (AC-9b). This
    // also covers a DB error occurring specifically during the theme-join (Task 6.3) — the whole
    // lookup fails open together, never a partial-success/partial-failure response.
    return reply.status(200).send(NO_SSO)
  }
}

export async function domainLookupRoutes(fastify: FastifyApp): Promise<void> {
  secureRoute(fastify, {
    method: 'POST',
    url: '/domain-lookup',
    bodyLimit: 4096,
    schema: {
      body: DomainLookupRequestSchema,
      response: {
        200: DomainLookupResponseSchema,
        422: ApiErrorSchema,
      },
    },
    security: {
      requireAuth: false,
      writeAuditEvent: false,
      // Story 14.4 AC-9 — matches /start's/callback's rate-limit convention; independent key so
      // this endpoint's own resource-exhaustion budget doesn't share a bucket with /start.
      rateLimit: {
        max: env.AUTH_SSO_DOMAIN_LOOKUP_RATE_LIMIT_MAX,
        timeWindowMs: 15 * 60 * 1000,
        key: 'POST /domain-lookup',
      },
    },
    handler: async (_ctx, request, reply) => handleDomainLookup(request, reply),
  })
}
