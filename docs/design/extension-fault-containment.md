# Decision record: containing extension-originated async faults

Status: accepted (Story 67.1). Addendum to the module-in-process decision (CentralizeMe ADR 0005)
and subject to ADR 0007 (no out-of-process isolation of CentralizeMe's build-time composed UI or
M7 API routes without an amendment).

## Problem

An extension is loaded into the PV API process. Faults in extension-owned async code are not
caught by Fastify's request error path. In Node 15 and later, an `'error'` event on an emitter
with no `'error'` listener (for example a `pg.Pool` whose database stops), and an unhandled
promise rejection, are fatal for the whole process. Found when a stopped CentralizeMe
control-plane Postgres made `pg-pool` re-emit `'error'` on a listener-less pool and the PV API
exited with code 1, taking every tenant and PV-native feature down.

After an `uncaughtException` the process state is undefined. "Contain and keep serving" is only
valid when the fault never reaches the process level.

## Options considered

| Option                                                                                    | Verdict                   | Reason                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (a) Documented contract plus conformance helper in `@project-vault/extension-api`         | Adopted (primary control) | Fixes the known class at the source, cheap, testable in the extension's own CI. Cannot enforce at runtime.                                                                                                                                                     |
| (b-lite) Last-resort handler: log, zero keys, exit non-zero                               | Adopted (backstop)        | Turns a raw crash (exit 1, raw stack, keys not zeroed) into an orderly, attributed exit the supervisor restarts.                                                                                                                                               |
| (b) Full supervised error boundary (attribute, mark the extension degraded, keep serving) | Deferred                  | Needs reliable attribution of out-of-band faults. A stack can only be matched by package path, a hostile extension can forge it, and many faults carry no extension frames. Keeping serving after `uncaughtException` is unsafe. Registered as follow-up work. |
| (c) Out-of-process isolation (worker or child process plus RPC)                           | Rejected for now          | Contradicts module-in-process, adds serialization and latency to every hook, complicates `getRequestContext()` and host-service bindings, and ADR 0007 forbids it for the composed UI and M7 routes without an amendment.                                      |

## Decision

1. **Contract (extension-api 3.34.0).** Every long-lived emitter an extension creates (pools,
   sockets, streams, clients) must carry an `'error'` listener, and every background promise must
   have a rejection handler. The package ships `checkExtensionEmitters`,
   `assertExtensionEmittersContained` and `checkBackgroundPromisesHandled` for the extension's CI.
   They report labels and counts only, never error text.
2. **Host backstop** (`apps/api/src/lib/fatal-fault-handler.ts`, installed first in
   `apps/api/src/main.ts`, before `createApp()` runs `loadExtension()`):
   - handles `uncaughtException` and `unhandledRejection` through one once-only path;
   - order: `zeroKeys()`, one `process.fatal_fault` log line, bounded `fastify.close()`
     (5 s), `process.exit(1)`;
   - never resumes serving. A second fault during the exit path exits immediately. A failing
     logger, `zeroKeys` or `close` still ends in `exit(1)`;
   - logs only the origin, `error.name` (shape-checked), an allow-listed `error.code`
     (`^[A-Z0-9_]{1,64}$`), `attribution` (`extension` or `unattributed`) and the manifest name
     when attributed. Never the message, stack text or payload, so connection strings cannot leak;
   - attribution is advisory: it matches the extension package install path in the stack
     (`node_modules/<pkg>/` or the pnpm layout) and never changes the exit decision.
3. **No audit event on this path.** The database may be the failing component, an out-of-band
   fault has no request org, and the exit must never wait on a write.

## Fault classes

| Class                                                  | Outcome                                                                        |
| ------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Listener-less emitter `'error'` (pool, socket, stream) | Caught by the contract in CI; at runtime the backstop logs and exits non-zero. |
| Unhandled rejection from extension background work     | Same.                                                                          |
| Fault inside a request or hook chain                   | Already contained by Fastify's error path; unchanged.                          |
| Fault with no extension frame in the stack             | Logged `unattributed`, still exits non-zero.                                   |

## Consequences

- A leaked extension fault still restarts the API, but in an orderly, greppable way
  (`eventType: process.fatal_fault`). Availability during the restart is the supervisor's job.
- The `/health` payload and extension status shape are unchanged (no new `faulted` state).
- Follow-up (not built): host-supplied pool/emitter factories and a supervised `faulted` state
  (option b), and any out-of-process direction (option c) with an ADR 0007 amendment.
- CentralizeMe adopts the helpers in its own CI (its Story 14-31 adds the listeners).
