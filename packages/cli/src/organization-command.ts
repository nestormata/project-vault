import { EXIT_CODES } from './exit-codes.js'
import { ensureFreshSession, type RefreshDeps } from './session-refresh.js'
import { writeSession, type SessionData } from './session-store.js'
import type { LoginStreams } from './login-command.js'

const ORG_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Deps = RefreshDeps & { writeSessionFn?: typeof writeSession }

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object'
}

function credentialOf(
  json: unknown,
  organizationId: string
): { accessToken: string; expiresIn: number; sessionId: string } | undefined {
  if (!isRecord(json) || !isRecord(json['data'])) return undefined
  const data = json['data']
  if (
    typeof data['accessToken'] !== 'string' ||
    typeof data['expiresIn'] !== 'number' ||
    typeof data['sessionId'] !== 'string' ||
    data['orgId'] !== organizationId
  ) {
    return undefined
  }
  return {
    accessToken: data['accessToken'],
    expiresIn: data['expiresIn'],
    sessionId: data['sessionId'],
  }
}

async function requestCredential(
  session: SessionData,
  organizationId: string,
  deps: Deps
): Promise<Response | undefined> {
  try {
    return await deps.fetchFn(`${session.baseUrl}/api/v1/auth/cli/org`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${session.accessToken}`,
      },
      body: JSON.stringify({ organizationId }),
    })
  } catch {
    return undefined
  }
}

function storeCredential(
  session: SessionData,
  organizationId: string,
  credential: { accessToken: string; expiresIn: number; sessionId: string },
  deps: Deps
): void {
  const next: SessionData = {
    ...session,
    orgCredentials: {
      ...session.orgCredentials,
      [organizationId]: {
        accessToken: credential.accessToken,
        accessExpiresAt: new Date(Date.now() + credential.expiresIn * 1000).toISOString(),
        orgId: organizationId,
        sessionId: credential.sessionId,
      },
    },
  }
  ;(deps.writeSessionFn ?? writeSession)(next, deps.env)
}

export async function runUseOrganization(
  organizationId: string,
  streams: LoginStreams,
  deps: Deps
): Promise<number> {
  if (!ORG_ID.test(organizationId)) {
    streams.stderr.write('organizationId must be a UUID.\n')
    return EXIT_CODES.unexpected
  }
  const session = await ensureFreshSession(deps)
  if (session.status !== 'ok' || session.session.scope !== 'user') {
    streams.stderr.write(
      'Not logged in with a browser-approved user session. Run `pvault login --browser`.\n'
    )
    return session.status === 'ok' ? EXIT_CODES.unexpected : EXIT_CODES.notLoggedIn
  }
  const response = await requestCredential(session.session, organizationId, deps)
  if (!response) {
    streams.stderr.write('The vault could not be reached.\n')
    return EXIT_CODES.unexpected
  }
  if (response.status === 403) {
    streams.stderr.write('You are not a member of that organization.\n')
    return EXIT_CODES.unexpected
  }
  const credential = credentialOf(await response.json().catch(() => null), organizationId)
  if (response.status !== 200 || !credential) {
    streams.stderr.write('The vault did not issue an organization credential.\n')
    return EXIT_CODES.unexpected
  }
  storeCredential(session.session, organizationId, credential, deps)
  streams.stdout.write(`Organization credential stored for ${organizationId}.\n`)
  return 0
}
