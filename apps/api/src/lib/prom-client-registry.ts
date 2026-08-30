import { Counter, register } from 'prom-client'

/** Some test files (e.g. session-revoke.test.ts) call `vi.resetModules()` and dynamically
 * re-import a module in this file's transitive import chain per test, which would otherwise
 * re-run `new Counter(...)` against prom-client's process-wide singleton `register` and throw
 * "already registered". Registration is idempotent instead: reuse the existing metric of the
 * same name if the module graph has already registered one. */
export function getOrCreateCounter<T extends string = string>(
  config: ConstructorParameters<typeof Counter<T>>[0]
): Counter<T> {
  const existing = register.getSingleMetric(config.name)
  if (existing instanceof Counter) return existing as Counter<T>
  return new Counter(config)
}
