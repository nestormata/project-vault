import { request as httpRequest } from 'node:http'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { OperationalEvent } from '@project-vault/shared'
import {
  FAULT_SENTINEL,
  FIXTURE_MANIFEST_NAME,
  INFLIGHT_MARKER,
  SLOW_ROUTE,
  hasEvent,
  killApiChild,
  parseJsonLine,
  removeFaultFixture,
  startApiChild,
  writeFaultFixture,
  type ApiChild,
  type FaultKind,
} from './helpers/fatal-fault-child-test-helpers.js'

// Story 67.2: real-process proof of the 67-1 last-resort fault handler. The unit tests inject
// `exit`/`close`; this file boots the real `apps/api/src/main.ts` as a child process against the
// test Postgres, makes an in-process extension leak a fault, and asserts what the supervisor and
// the operator see: exit code 1, one attributed `process.fatal_fault` line without the error
// message, and a graceful `app.close()` (an in-flight request still completes).
//
// Timing policy: every wait is event driven (child log line, child `exit`, socket result). The
// bounds below are ceilings for a hung child, never part of an assertion.

const BOOT_BOUND_MS = 50_000
const EXIT_BOUND_MS = 20_000
// Above the sum of the phase bounds, so a hung phase fails with its own message and log tail
// rather than vitest's generic 60 s test timeout.
const TEST_BOUND_MS = BOOT_BOUND_MS + 2 * EXIT_BOUND_MS + 10_000

type Scenario = {
  kind: FaultKind
  origin: 'uncaughtException' | 'unhandledRejection'
  attribution: 'extension' | 'unattributed'
  errorName: string
  /** Allow-listed code the handler logs when the error carries one. */
  errorCode?: string
}

const SCENARIOS: Scenario[] = [
  { kind: 'emitter', origin: 'uncaughtException', attribution: 'extension', errorName: 'Error' },
  { kind: 'rejection', origin: 'unhandledRejection', attribution: 'extension', errorName: 'Error' },
  // The pg socket teardown has no fixture frame in its stack, and stack-path attribution is
  // advisory only (DW-572, DW-574 item 4). Pinned on purpose: better attribution is a visible
  // change to this test.
  {
    kind: 'pool',
    origin: 'uncaughtException',
    attribution: 'unattributed',
    // Postgres' own error object (admin_shutdown after pg_terminate_backend).
    errorName: 'error',
    errorCode: '57P01',
  },
]

type InflightResult =
  { outcome: 'response'; status: number; body: string } | { outcome: 'error'; message: string }

function startInflightRequest(port: number): Promise<InflightResult> {
  return new Promise((resolveResult) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path: SLOW_ROUTE, method: 'GET', agent: false },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => (body += chunk))
        res.on('end', () =>
          resolveResult({ outcome: 'response', status: res.statusCode ?? 0, body })
        )
        res.on('error', (error) => resolveResult({ outcome: 'error', message: error.message }))
      }
    )
    req.on('error', (error) => resolveResult({ outcome: 'error', message: error.message }))
    req.end()
  })
}

function connectRefused(port: number): Promise<boolean> {
  return new Promise((resolveRefused) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: '/health', agent: false })
    req.on('error', (error: NodeJS.ErrnoException) => resolveRefused(error.code === 'ECONNREFUSED'))
    req.on('response', (res) => {
      res.resume()
      resolveRefused(false)
    })
    req.end()
  })
}

function withBound<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
  tail: () => string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const bound = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}\n${tail()}`)), ms)
  })
  return Promise.race([promise, bound]).finally(() => clearTimeout(timer))
}

describe('fatal fault handler: real API process (Story 67.2)', () => {
  let child: ApiChild | undefined

  beforeAll(() => writeFaultFixture())
  afterAll(() => removeFaultFixture())
  afterEach(() => {
    killApiChild(child)
    child = undefined
  })

  describe.each(SCENARIOS)(
    'leaked $kind fault',
    ({ kind, origin, attribution, errorName, errorCode }) => {
      it(
        `exits 1 after one ${attribution} fatal line, closing the server gracefully`,
        async () => {
          child = await startApiChild(kind)
          await withBound(
            child.waitForLine(
              (l) => hasEvent(l, OperationalEvent.STARTUP_COMPLETE),
              'startup.complete'
            ),
            BOOT_BOUND_MS,
            'startup.complete',
            child.tail
          )
          const apiChild = child

          // A request that stays in flight until the fault has reached the host's handler.
          const inflight = startInflightRequest(apiChild.port)
          await withBound(
            apiChild.waitForLine((l) => l.includes(INFLIGHT_MARKER), 'in-flight marker'),
            EXIT_BOUND_MS,
            'in-flight marker',
            apiChild.tail
          )

          let exitSeenAt: number | undefined
          let responseSeenAt: number | undefined
          const order = { n: 0 }
          void apiChild.exited.then(() => (exitSeenAt = ++order.n))
          void inflight.then(() => (responseSeenAt = ++order.n))

          apiChild.process.kill('SIGUSR2')
          const exit = await withBound(apiChild.exited, EXIT_BOUND_MS, 'child exit', apiChild.tail)
          const response = await inflight

          // Exit: non-zero by the handler, not killed by a signal.
          expect(exit, apiChild.tail()).toEqual({ code: 1, signal: null })

          // Graceful close: the in-flight request completed with a full response, before the exit.
          expect(response).toEqual({ outcome: 'response', status: 200, body: expect.any(String) })
          expect(response.outcome === 'response' && JSON.parse(response.body)).toHaveProperty(
            'status'
          )
          expect(responseSeenAt).toBeLessThan(exitSeenAt ?? Number.POSITIVE_INFINITY)

          // Exactly one attributed fatal line.
          const fatalLines = apiChild.lines
            .filter((l) => hasEvent(l, OperationalEvent.PROCESS_FATAL_FAULT))
            .map((l) => parseJsonLine(l))
          expect(fatalLines).toHaveLength(1)
          expect(fatalLines[0]).toMatchObject({
            level: 'fatal',
            eventType: OperationalEvent.PROCESS_FATAL_FAULT,
            origin,
            errorName,
            ...(errorCode ? { errorCode } : {}),
            attribution,
            extension: attribution === 'extension' ? FIXTURE_MANIFEST_NAME : null,
          })

          // Redaction: the error message never reaches the process output.
          expect(apiChild.lines.join('\n')).not.toContain(FAULT_SENTINEL)

          // The listener is gone with the process.
          expect(await connectRefused(apiChild.port)).toBe(true)
        },
        TEST_BOUND_MS
      )
    }
  )
})
