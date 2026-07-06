/**
 * D1 — bounds each `getSecret()`/token-exchange call so a hung DNS resolution or TCP handshake
 * doesn't stall a CI job for its full `timeout-minutes`. `@project-vault/agent`'s internal
 * `fetch()` calls accept no external `AbortSignal`, so this wraps the *outer* call promise with
 * its own fixed 10s deadline; a timeout is treated as vault-unreachable (D4), exactly like a
 * connection refusal.
 */

export const VAULT_ACTION_TIMEOUT_MS = 10_000

export class VaultActionTimeoutError extends Error {
  code = 'vault_action_timeout'

  constructor(message = `Timed out after ${VAULT_ACTION_TIMEOUT_MS}ms waiting for the vault`) {
    super(message)
    this.name = 'VaultActionTimeoutError'
  }
}

export function withTimeout<T>(
  fn: () => Promise<T>,
  ms: number = VAULT_ACTION_TIMEOUT_MS
): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout>

  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new VaultActionTimeoutError())
    }, ms)
  })

  return Promise.race([fn(), timeoutPromise]).finally(() => clearTimeout(timer))
}
