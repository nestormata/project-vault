export type CookieJar = Record<string, string>
type InitVault = (
  config: { kmsType: 'passphrase'; passphrase: string },
  headers: Record<string, string | string[] | undefined>
) => Promise<unknown>

export function configureAuthIntegrationEnv(): void {
  process.env['DATABASE_URL'] ??=
    'postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault'
  process.env['VAULT_ALLOW_REMOTE_INIT'] = 'true'
}

export function parseSetCookies(setCookie: string | string[] | undefined): CookieJar {
  const headers = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : []
  return Object.fromEntries(
    headers
      .map((header) => header.split(';')[0] ?? '')
      .filter(Boolean)
      .map((cookie) => {
        const [name, ...valueParts] = cookie.split('=')
        return [name, valueParts.join('=')]
      })
  )
}

export function cookieHeader(jar: CookieJar): string {
  return Object.entries(jar)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ')
}

export async function initVaultForTest(initVault: InitVault, passphrase: string): Promise<void> {
  try {
    await initVault({ kmsType: 'passphrase', passphrase }, {})
  } catch (error) {
    if ((error as { code?: string }).code !== 'ALREADY_INITIALIZED') throw error
  }
}
