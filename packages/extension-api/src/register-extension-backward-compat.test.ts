import { describe, expect, it } from 'vitest'
import { EXTENSION_API_VERSION } from './manifest.js'
import type { ExtensionManifest } from './manifest.js'
import { registerExtension } from './register-extension.js'
import type { ExtensionHooks } from './register-extension.js'

const manifest: ExtensionManifest = {
  name: 'com.acme.legacy-extension',
  apiVersion: EXTENSION_API_VERSION,
  capabilities: ['auth-provider'],
}

/**
 * Story 23.8 AC-4 — a pre-23.8 extension's `hooksFactory` is declared with ZERO parameters
 * (ignoring the new `host` argument entirely). TypeScript's parameter-count contravariance
 * allows a function declaring fewer parameters than the target type to satisfy it, so this must
 * still compile and run unmodified against the new `(host: HostServices) => ExtensionHooks`
 * signature.
 */
const legacyHooksFactory: () => ExtensionHooks = () => ({
  authStrategy: {
    onAuthenticate: async () => ({
      externalSubject: 'fixture-subject',
      providerName: 'fixture-provider',
    }),
  },
})

describe('registerExtension — AC-4 backward compatibility (pre-23.8 zero-arg hooksFactory)', () => {
  it('a hooksFactory declared with zero parameters remains assignable and runs unmodified', () => {
    const result = registerExtension(manifest, legacyHooksFactory)
    expect(result.hooks.authStrategy).toBeDefined()
  })
})
