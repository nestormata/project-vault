import type { X509Certificate } from 'node:crypto'
import type { Server } from 'node:net'
import type { FastifyBaseLogger } from 'fastify'
import { OperationalEvent } from '@project-vault/shared'
import { INTERNAL_TLS_EXPIRY_WARN_DAYS, certificateExpiry } from '@project-vault/shared/node-tls'
import type { ApiListenerTls } from '../config/internal-tls.js'
import { operationalLog } from './logger.js'
import { getOrCreateGauge } from './prom-client-registry.js'

/**
 * Story 43.16 AC-9 / AC-14: observability for the Fly demo's internal-TLS leaves the api holds —
 * its listener's server certificate and its Postgres client certificate. Everything here is
 * computed lazily from the parsed `notAfter` (no timers). Certificate and key material is never
 * logged or exported.
 */

export type InternalTlsLeafName = 'api-server' | 'db-client'

const configuredLeaves = new Map<InternalTlsLeafName, X509Certificate>()

function leafPairs(leaves: {
  apiServer: X509Certificate | null
  dbClient: X509Certificate | null
}): [InternalTlsLeafName, X509Certificate][] {
  const pairs: [InternalTlsLeafName, X509Certificate | null][] = [
    ['api-server', leaves.apiServer],
    ['db-client', leaves.dbClient],
  ]
  return pairs.filter((pair): pair is [InternalTlsLeafName, X509Certificate] => pair[1] !== null)
}

/** Called by `createApp` with the leaves this process actually uses. */
export function setInternalTlsLeaves(leaves: {
  apiServer: X509Certificate | null
  dbClient: X509Certificate | null
}): void {
  configuredLeaves.clear()
  for (const [which, leaf] of leafPairs(leaves)) configuredLeaves.set(which, leaf)
}

const WARN_SECONDS = INTERNAL_TLS_EXPIRY_WARN_DAYS * 86_400

export type InternalTlsExpiring = { which: InternalTlsLeafName; daysRemaining: number }

function expiringLeaves(
  pairs: Iterable<[InternalTlsLeafName, X509Certificate]>,
  now: Date
): (InternalTlsExpiring & { notAfter: string })[] {
  return [...pairs].flatMap(([which, leaf]) => {
    const expiry = certificateExpiry(leaf, now)
    return expiry.secondsRemaining < WARN_SECONDS
      ? [{ which, daysRemaining: expiry.daysRemaining, notAfter: expiry.notAfter }]
      : []
  })
}

/** `/ready`'s degraded-not-failing signal. An already-expired leaf is never reported here: the
 * api would not be reachable (listener) or would not have a DB pool (client) in that state. */
export function internalTlsExpiring(now: Date = new Date()): InternalTlsExpiring[] {
  return expiringLeaves(configuredLeaves, now).map(({ which, daysRemaining }) => ({
    which,
    daysRemaining,
  }))
}

// Seconds until notAfter per configured leaf. With TLS off there is no series at all — a 0 would
// read as "expired".
getOrCreateGauge({
  name: 'pv_internal_tls_cert_expiry_seconds',
  help: 'Seconds until the internal-TLS certificate notAfter (Fly demo only)',
  labelNames: ['which'],
  collect() {
    this.reset()
    const now = new Date()
    for (const [which, leaf] of configuredLeaves) {
      this.set({ which }, certificateExpiry(leaf, now).secondsRemaining)
    }
  },
})

type StartupLogger = Pick<FastifyBaseLogger, 'info' | 'warn'>

export type InternalTlsStartupState = {
  listener: ApiListenerTls | null
  dbClientLeaf: X509Certificate | null
  dbPinned: boolean
}

function notAfterOf(leaf: X509Certificate | null | undefined, now: Date): string | null {
  return leaf ? certificateExpiry(leaf, now).notAfter : null
}

export function logInternalTlsStartup(
  log: StartupLogger,
  state: InternalTlsStartupState,
  now: Date
): void {
  const serverLeaf = state.listener?.leaf ?? null
  operationalLog(
    log,
    'info',
    OperationalEvent.INTERNAL_TLS_CONFIGURED,
    'Internal TLS configuration',
    {
      internalTls: state.listener?.mode ?? 'off',
      certSubjectAltName: serverLeaf?.subjectAltName ?? null,
      certNotAfter: notAfterOf(serverLeaf, now),
      dbTls: state.dbPinned ? 'pinned-ca' : 'off',
      dbClientCertNotAfter: notAfterOf(state.dbClientLeaf, now),
    }
  )
  const pairs = leafPairs({ apiServer: serverLeaf, dbClient: state.dbClientLeaf })
  for (const { which, daysRemaining, notAfter } of expiringLeaves(pairs, now)) {
    operationalLog(
      log,
      'warn',
      OperationalEvent.INTERNAL_TLS_CERT_EXPIRING,
      'Internal TLS certificate expires soon; rotate it (docs/runbooks/fly-internal-tls.md)',
      { which, daysRemaining, certNotAfter: notAfter }
    )
  }
}

const HANDSHAKE_WARN_WINDOW_MS = 60_000
const HANDSHAKE_TRACKED_ADDRESSES_MAX = 1_000

function pruneExpired(lastLoggedAt: Map<string, number>, now: number): void {
  for (const [address, at] of lastLoggedAt) {
    if (now - at >= HANDSHAKE_WARN_WINDOW_MS) lastLoggedAt.delete(address)
  }
}

/**
 * AC-9: logs failed TLS handshakes (an org-neighbour probe, or a stale web cert) at `warn`, at
 * most one line per remote address per 60 s so a probe cannot flood the logs. Fields are
 * `remoteAddress` and `code` only. The tracking map is bounded; when it is full of addresses still
 * inside their window, further new addresses are not logged until entries age out.
 */
export function watchTlsHandshakeFailures(
  server: Server,
  log: Pick<FastifyBaseLogger, 'warn'>,
  clock: () => number = Date.now
): void {
  const lastLoggedAt = new Map<string, number>()
  server.on(
    'tlsClientError',
    (error: NodeJS.ErrnoException, socket: { remoteAddress?: string }) => {
      const now = clock()
      const remoteAddress = socket.remoteAddress ?? 'unknown'
      const previous = lastLoggedAt.get(remoteAddress)
      if (previous !== undefined && now - previous < HANDSHAKE_WARN_WINDOW_MS) return
      if (lastLoggedAt.size >= HANDSHAKE_TRACKED_ADDRESSES_MAX) pruneExpired(lastLoggedAt, now)
      if (lastLoggedAt.size >= HANDSHAKE_TRACKED_ADDRESSES_MAX) return
      lastLoggedAt.set(remoteAddress, now)
      operationalLog(
        log,
        'warn',
        OperationalEvent.INTERNAL_TLS_HANDSHAKE_FAILED,
        'Internal TLS handshake failed',
        {
          remoteAddress,
          code: error.code ?? 'unknown',
        }
      )
    }
  )
}
