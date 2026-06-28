import adapter from '@sveltejs/adapter-node'

/** @type {import('@sveltejs/kit').Config} */
const config = {
  kit: {
    adapter: adapter(),
    alias: {
      '@project-vault/shared': '../../packages/shared/src/index.ts',
    },
  },
}

export default config
