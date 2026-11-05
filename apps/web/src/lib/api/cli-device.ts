import { apiFetch } from './client.js'

export type CliDeviceDecisionResult = { status: 'approved' | 'denied'; expiresIn?: number }

export function decideCliDeviceLogin(
  fetchFn: typeof fetch,
  body: { userCode: string; decision: 'approve' | 'deny'; totpCode?: string }
) {
  return apiFetch<CliDeviceDecisionResult>(fetchFn, '/api/v1/auth/cli/device/decision', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}
