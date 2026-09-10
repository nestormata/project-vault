import { describe, expect, it } from 'vitest'
import { scanText } from './check-public-safety.js'

const LOCAL_ENDPOINT_RULE = 'local-endpoint'
const SECRET_VALUE_RULE = 'secret-environment-value'
const CREDENTIAL_LITERAL_RULE = 'credential-literal-assignment'
const SECRET_ASSIGNMENT_RULE = 'secret-assignment'

const ENV_EXAMPLE = '.env.example'
const DOC_FILE = 'docs/example.md'
const CONFIG_DOC = 'docs/configuration.md'
const WORKFLOW_FILE = '.github/workflows/ci.yml'
const API_TEST_FILE = 'apps/api/src/example.test.ts'

// Synthetic credential shapes are assembled from short, low-entropy chunks at runtime. This file
// tests a secret detector, so embedding a real-looking literal here would (correctly) trip the
// repository's own no-secrets ESLint rule. Joining the chunks keeps the detector's input identical
// while leaving no secret-shaped literal in the source.
const OPAQUE_TOKEN = ['Kj8Wm2Qp', 'Zx9Lr4Tn', '7Vb3Yc6H', 'd0Fg1Sa'].join('')
const OPAQUE_TOKEN_ALT = ['Xq7fJ2pL', 'm9RvTz4a', 'B8cD1eG5', 'hK3nP0wY'].join('')
const HEX_32 = ['9f3c2a71', 'bd4e8056', 'af1c93d2', '7be540ac'].join('')
const HEX_40 = ['a1b2c3d4', 'e5f60718', '293a4b5c', '6d7e8f90', 'a1b2c3d4'].join('')
const VENDOR_KEY = ['sk', 'live', ['51HxYzAb', 'C9dEfGh2', 'iJkLmNoPq'].join('')].join('_')

const rules = (file: string, text: string) => scanText(file, text).map((finding) => finding.rule)

describe('check-public-safety', () => {
  it('detects literal secret material', () => {
    const findings = scanText(DOC_FILE, 'api_key = "super-secret-value"')
    expect(findings.some((finding) => finding.rule === SECRET_ASSIGNMENT_RULE)).toBe(true)
  })

  it('does not treat secret-related help markup as a secret assignment', () => {
    const findings = scanText(
      'apps/web/src/lib/components/auth/LoginForm.svelte',
      '<FormHelpText id="login-password-help" kind="secret" />'
    )

    expect(findings.some((finding) => finding.rule === SECRET_ASSIGNMENT_RULE)).toBe(false)
  })

  it('detects personal and machine-specific information', () => {
    const findings = scanText(
      'scripts/setup.sh',
      'Contact nestor@example.com; local worktree: /home/nestor/project/.worktrees/story; http://localhost:5173'
    )
    expect(findings.map((finding) => finding.rule)).toEqual(
      expect.arrayContaining(['personal-email', 'local-path', LOCAL_ENDPOINT_RULE])
    )
  })

  it('does not flag ordinary implementation text', () => {
    expect(scanText('apps/web/src/lib/example.ts', 'export const answer = 42')).toEqual([])
  })

  it('does not treat the shared field-count domain constant as an environment variable', () => {
    expect(scanText('packages/shared/src/schemas/credentials.ts', 'MAX_FIELDS_PER_SECRET')).toEqual(
      []
    )
  })

  it('does not treat PostgreSQL connection-string userinfo as a personal email', () => {
    expect(
      scanText(
        'packages/db/src/test-db-urls.ts',
        'postgresql://vault_admin@admin-db.invalid:5432/project_vault'
      )
    ).not.toContainEqual(expect.objectContaining({ rule: 'personal-email' }))
  })

  describe(SECRET_VALUE_RULE, () => {
    it('flags a secret-shaped variable assigned a real-looking literal, in any file', () => {
      expect(
        rules('apps/api/src/lib/boot.ts', `const NEW_SERVICE_TOKEN = "${OPAQUE_TOKEN_ALT}"`)
      ).toContain(SECRET_VALUE_RULE)
      expect(rules('.github/workflows/deploy.yml', `SESSION_SECRET=${HEX_32}${HEX_32}`)).toContain(
        SECRET_VALUE_RULE
      )
      // A name formerly on the deleted global allowlist gets no free pass once it carries a value.
      expect(
        rules('docs/runbooks/example.md', `export VAULT_ADMIN_PASSWORD=${OPAQUE_TOKEN}`)
      ).toContain(SECRET_VALUE_RULE)
    })

    it('checks every assignment on the line, not just the first', () => {
      expect(rules(DOC_FILE, `SAFE_NAME=hello and MY_TOKEN=${OPAQUE_TOKEN}`)).toContain(
        SECRET_VALUE_RULE
      )
    })

    it('does not flag a secret-shaped name that carries no value', () => {
      expect(rules(ENV_EXAMPLE, 'API_KEY_HMAC_SECRET=')).toEqual([])
      expect(rules(CONFIG_DOC, '| `API_KEY_HMAC_SECRET` | dev value | required |')).toEqual([])
      expect(
        rules(
          'docs/runbooks/secret-rotation.md',
          '1. Low impact: `SESSION_SECRET`, `MACHINE_JWT_SECRET`.'
        )
      ).toEqual([])
      expect(
        rules('scripts/rotate.sh', 'for v in SESSION_SECRET REFRESH_TOKEN_HMAC_SECRET; do')
      ).toEqual([])
      expect(rules('apps/api/src/index.ts', 'apiKey: process.env.VAULT_API_KEY!,')).toEqual([])
    })

    it('does not flag an expansion, substitution or generation command as a literal value', () => {
      expect(
        rules('docker-compose.prod.yml', 'SESSION_SECRET: ${SESSION_SECRET:?required}')
      ).toEqual([])
      expect(rules(WORKFLOW_FILE, 'SONAR_TOKEN: ${{ secrets.SONAR_TOKEN }}')).toEqual([])
      expect(rules(DOC_FILE, 'export VAULT_BOOTSTRAP_TOKEN="$(openssl rand -base64 32)"')).toEqual(
        []
      )
      expect(rules(DOC_FILE, '  -H "X-Vault-Bootstrap-Token: $VAULT_BOOTSTRAP_TOKEN" \\')).toEqual(
        []
      )
    })

    it('does not flag the dev-only and placeholder values this repository publishes', () => {
      // apps/api/src/config/env.ts's KNOWN_DEV_SECRET_VALUES are twelve `'x'.repeat(64)` literals.
      // The character-diversity test covers the shape, so this stays true as that list changes.
      for (const char of 'abcdefghijkl') {
        expect(rules(ENV_EXAMPLE, `SESSION_SECRET=${char.repeat(64)}`)).toEqual([])
      }
      expect(rules(ENV_EXAMPLE, 'POSTGRES_PASSWORD=password')).toEqual([])
      expect(rules(ENV_EXAMPLE, 'MACHINE_JWT_SECRET=change-me-in-production-0000')).toEqual([])
      expect(rules(API_TEST_FILE, "const DEFAULT_CSRF_TOKEN = 'test-csrf-token'")).toEqual([])
      expect(
        rules(
          'packages/crypto/src/passwords.test.ts',
          "const USER_PASSWORD = 'correct-horse-battery-staple'"
        )
      ).toEqual([])
    })

    it('does not flag identifiers, slugs, routes or event names', () => {
      expect(
        rules(
          'packages/shared/src/constants/audit-events.ts',
          "  MACHINE_USER_API_KEY_ISSUED: 'machine_user.api_key_issued',"
        )
      ).toEqual([])
      expect(
        rules(API_TEST_FILE, "const MACHINE_TOKEN_URL = '/api/v1/auth/machine-token'")
      ).toEqual([])
      expect(
        rules('apps/web/e2e/j1.spec.ts', "const OWNER_PASSWORD = 'e2e-Owner-Password-123'")
      ).toEqual([])
      expect(
        rules('scripts/example.test.ts', 'env: { ...process.env, PGPASSWORD: undefined },')
      ).toEqual([])
    })
  })

  describe(CREDENTIAL_LITERAL_RULE, () => {
    it('flags a high-entropy literal assigned to any environment-shaped name', () => {
      expect(rules('apps/api/src/example.ts', `STRIPE_KEY=${VENDOR_KEY}`)).toContain(
        CREDENTIAL_LITERAL_RULE
      )
    })

    it('does not flag git SHAs, digests or versions', () => {
      expect(rules(WORKFLOW_FILE, `COMMIT_SHA=${HEX_40}`)).toEqual([])
      expect(rules(WORKFLOW_FILE, 'NODE_VERSION=20.11.0')).toEqual([])
    })
  })

  it('allows local endpoints in reviewed local configuration files and in prose documentation', () => {
    expect(
      scanText(
        ENV_EXAMPLE,
        'DATABASE_URL=postgresql://vault_app:password@localhost:5432/project_vault'
      )
    ).not.toContainEqual(expect.objectContaining({ rule: LOCAL_ENDPOINT_RULE }))
    expect(rules(CONFIG_DOC, '| `WEB_BASE_URL` | `http://localhost:5173` |')).not.toContain(
      LOCAL_ENDPOINT_RULE
    )
    expect(rules('apps/web/src/lib/api.ts', "const base = 'http://localhost:3000'")).toContain(
      LOCAL_ENDPOINT_RULE
    )
  })

  it('still flags machine-specific paths inside prose documentation', () => {
    expect(rules('docs/runbooks/example.md', 'cd /home/nestor/Proyects/project-vault')).toContain(
      'local-path'
    )
  })
})
