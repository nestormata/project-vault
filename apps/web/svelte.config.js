import adapter from '@sveltejs/adapter-node'

/** @type {import('@sveltejs/kit').Config} */
const config = {
  kit: {
    adapter: adapter(),
    alias: {
      // Story 43.16: node-only subpath exports, listed before the package root so they win.
      '@project-vault/shared/node-tls': '../../packages/shared/src/node/internal-tls-pem.ts',
      '@project-vault/shared/test-pki': '../../packages/shared/src/node/test-pki-test-helpers.ts',
      '@project-vault/shared': '../../packages/shared/src/index.ts',
    },
  },
}

export default config
