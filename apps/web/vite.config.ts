import { sveltekit } from '@sveltejs/kit/vite'
import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import { paraglideVitePlugin } from '@inlang/paraglide-js'

export default defineConfig({
  plugins: [
    tailwindcss(),
    // Story 15.1 — compiles project.inlang/settings.json + messages/{locale}.json into
    // src/lib/paraglide/* (typesafe, tree-shaken message functions). Cookie-based locale
    // strategy per the story's ADR (see story Dev Notes "Architecture Decision Record — locale
    // routing strategy"): no URL prefixing, so no route in the app changes shape when a user
    // switches locale.
    paraglideVitePlugin({
      project: './project.inlang',
      outdir: './src/lib/paraglide',
      strategy: ['cookie', 'baseLocale'],
      // Task 4.4 — an undefined message key must be a TypeScript compile error, not a runtime
      // surprise (relied upon by AC 3's "wholly-undefined key" edge case instead of a runtime
      // guard).
      emitTsDeclarations: true,
    }),
    sveltekit(),
  ],
})
