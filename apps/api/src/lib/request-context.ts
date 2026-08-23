import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Story 23.11 AC1 — the ambient per-request context: the org/identity that is legitimately
 * driving the current request, for the lifetime of that request's async execution. This is the
 * one binding point `checkOrgAuthorization()` (`org-authorization.ts`) trusts for `orgId`
 * instead of an extension-supplied field (AC3).
 */
export type RequestContext = {
  orgId: string
  userId: string
}

/**
 * Internal storage cell. `AsyncLocalStorage` propagates a snapshot of whatever value is
 * *currently bound* to every async continuation spawned from the point it was bound — but
 * `authenticateRequest()` (the AC2 binding point) only learns `orgId`/`userId` after its own
 * internal `await`s (DB lookups) resolve. A second `enterWith()` call issued *after* those
 * internal awaits does not reliably propagate back out to Fastify's own hook dispatcher once it
 * resumes past its `await fastify.authenticate(request, reply)` — that resumption is a
 * continuation that was already linked to the async context active *before* authenticateRequest
 * ever ran, so it observes the pre-bind (unbound) context, not a later `enterWith()` call made
 * deep inside a nested, already-`await`-suspended callee. This is standard Node/V8
 * AsyncLocalStorage + async/await behavior, not a Fastify quirk (reproduced with a bare
 * `async function bindsLate() { await x; als.enterWith(v) }; await bindsLate(); als.getStore()`
 * — the caller sees `undefined`).
 *
 * The fix: bind a single, long-lived *mutable* box once, as early as possible (before
 * `authenticateRequest()` or any other preHandler runs — see `bindRequestContextLifecycle()`
 * below, registered as a global `onRequest` hook), and have `bindRequestContext()` MUTATE that
 * box's `context` field in place rather than rebinding a new value via `enterWith()`. Because
 * every continuation from `onRequest` onward carries the *same object reference*, a later
 * mutation is visible everywhere that reference is read, regardless of how many awaits separate
 * the mutation from any given read.
 */
type RequestContextBox = { context: RequestContext | undefined }

const requestContextStorage = new AsyncLocalStorage<RequestContextBox>()

/**
 * AC2/AC9 — registered as a Fastify `onRequest` hook (see `authenticate.ts`'s plugin
 * registration), before any preHandler — including `authenticate` itself — ever runs. Opens an
 * empty box (`context: undefined`) for the remainder of this request's lifecycle via
 * `AsyncLocalStorage.run()`, which correctly threads the SAME box reference through every
 * subsequent hook stage, the route handler, and any extension hook they trigger, including
 * across further `await`s. `bindRequestContext()` later mutates this box's `context` field once
 * `authenticateRequest()` has resolved `orgId`/`userId` — see that function's own module
 * docstring above for why a bare `enterWith()` call at that later point cannot be relied on
 * instead.
 */
export function bindRequestContextLifecycle(
  _request: unknown,
  _reply: unknown,
  done: () => void
): void {
  requestContextStorage.run({ context: undefined }, done)
}

/**
 * AC2/AC9 — binds `context` into the current request's box (opened by
 * `bindRequestContextLifecycle()`'s `onRequest` hook). Intended to be called synchronously
 * inside `authenticate.ts`'s `authenticateRequest()` preHandler, immediately after
 * `request.authContext` is assigned.
 *
 * Mutates the existing box in place when one is open (the real Fastify-request path — see the
 * module docstring above for why this, not `enterWith()`, is what makes the value visible to
 * every later stage of the SAME request). Falls back to `enterWith()` on a fresh box when no box
 * is open — e.g. a direct, non-Fastify-wrapped call in a test — so the synchronous remainder of
 * that execution still observes the bound value, even though propagation guarantees for that
 * fallback path are the ordinary (weaker) `enterWith()` ones.
 */
export function bindRequestContext(context: RequestContext): void {
  const box = requestContextStorage.getStore()
  if (box) {
    box.context = context
    return
  }
  requestContextStorage.enterWith({ context })
}

/**
 * AC1 — never throws. Returns `undefined` when called outside any bound request (e.g. a
 * machine-authenticated route that never populates `request.authContext` and therefore never
 * calls `bindRequestContext()`, or code running outside any request lifecycle entirely, such as
 * a background timer), or when called after `onRequest` has opened the box but before
 * `bindRequestContext()` has populated it yet. Callers (e.g. `checkOrgAuthorization()`) decide
 * how to fail — this getter itself never throws and never guesses a fallback value.
 */
export function getRequestContext(): RequestContext | undefined {
  return requestContextStorage.getStore()?.context
}

/**
 * Test/tooling helper — runs `fn` with `context` bound for its entire (possibly async) duration,
 * using `AsyncLocalStorage.run()`'s scoped-callback form. Production code binds via the
 * `onRequest` hook (`bindRequestContextLifecycle()`) plus `bindRequestContext()` inside the real
 * `authenticate` preHandler (AC2); this helper exists so tests (and any future non-HTTP caller
 * that already has a natural callback boundary and knows its context value upfront) can bind an
 * ambient context without a real Fastify request.
 */
export function runWithRequestContext<T>(context: RequestContext, fn: () => T): T {
  return requestContextStorage.run({ context }, fn)
}
