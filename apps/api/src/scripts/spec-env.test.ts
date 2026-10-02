import { describe, expect, it } from 'vitest'
import { prepareSpecGenerationEnv } from './spec-env.js'

describe('Story 68.8 AC-15 — the committed OpenAPI spec stays PV-only', () => {
  it('removes the extension package, the required flag and the release version', () => {
    const env: NodeJS.ProcessEnv = {
      VAULT_EXTENSIONS_PACKAGE: '@project-vault/mock-api-routes-extension',
      VAULT_EXTENSIONS_REQUIRED: 'true',
      RELEASE_VERSION: '9.9.9',
      DATABASE_URL: 'postgresql://vault_app@db:5432/project_vault',
      OTHER: 'kept',
    }

    prepareSpecGenerationEnv(env)

    expect(env).toEqual({
      DATABASE_URL: 'postgresql://vault_app@db:5432/project_vault',
      OTHER: 'kept',
    })
  })

  it('defaults DATABASE_URL to a password-free placeholder when unset', () => {
    const env: NodeJS.ProcessEnv = {}
    prepareSpecGenerationEnv(env)
    expect(env['DATABASE_URL']).toBe('postgresql://vault_app@localhost:5432/project_vault')
  })

  it('leaves an environment without extension settings unchanged apart from DATABASE_URL', () => {
    const env: NodeJS.ProcessEnv = { DATABASE_URL: 'postgresql://vault_app@x/y' }
    prepareSpecGenerationEnv(env)
    expect(env).toEqual({ DATABASE_URL: 'postgresql://vault_app@x/y' })
  })
})
