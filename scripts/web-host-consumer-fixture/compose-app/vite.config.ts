import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pvComposeDev } from '@project-vault/composition-kit/vite'
import { viteConfig } from '@project-vault/web-host/vite.config'

// Vite bundles this file into a temporary one, where only import.meta.url is reliable.
const appRoot = fileURLToPath(new URL('.', import.meta.url))
const hostDir = dirname(
  createRequire(import.meta.url).resolve('@project-vault/web-host/package.json')
)

// The dev variant also runs the composer in watch mode (the plugin only applies to `vite dev`).
const dev = process.env.PV_FIXTURE_DEV === '1'
const plugins = dev
  ? [pvComposeDev({ appRoot, packRoot: process.env.PV_FIXTURE_PACK ?? '', hostDir })]
  : []

export default viteConfig({ plugins }, { appRoot, composedRoot: appRoot })
