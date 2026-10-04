import { generateE2EVaultPassphrase } from '../../src/lib/server/e2e-setup-security.js'
import { pollUntilOk } from '../fixtures/poll-until-ready.js'
import { apiBaseUrl } from './fixtures.js'

// Story 68.10: the composed stack boots on a fresh database through PV's own `migrate` service (a
// real migration run), so unlike the shared suite's global setup there is NO database reset here:
// readiness, vault init, readiness again. The first request of the suite is this probe, so a slow
// API is a bounded wait, never a red spec.
export default async function globalSetup(): Promise<void> {
  const base = apiBaseUrl()
  await pollUntilOk(`${base}/health`, {
    attempts: 40,
    delayMs: 3000,
    onExhausted: (lastError) => new Error(`API /health never became ready: ${String(lastError)}`),
  })
  const init = await fetch(`${base}/api/v1/vault/init`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kmsType: 'passphrase', passphrase: generateE2EVaultPassphrase() }),
  })
  if (!init.ok && init.status !== 409) {
    throw new Error(`vault/init failed (${init.status}) on ${new URL(base).host}`)
  }
  await pollUntilOk(`${base}/ready`, {
    attempts: 20,
    delayMs: 3000,
    onExhausted: (lastError) => new Error(`API /ready never became ready: ${String(lastError)}`),
  })
}
