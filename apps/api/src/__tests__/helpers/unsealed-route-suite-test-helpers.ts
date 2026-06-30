import { afterAll, beforeAll } from 'vitest'
import type { createApp } from '../../app.js'
import { bootUnsealedRouteApp } from './auth-test-helpers.js'

type TestApp = Awaited<ReturnType<typeof createApp>>

export function createUnsealedRouteSuite(
  initVault: Parameters<typeof bootUnsealedRouteApp>[0],
  passphrase: string
) {
  let app!: TestApp
  let closeSuite!: () => Promise<void>

  return {
    get app(): TestApp {
      return app
    },
    set app(next: TestApp) {
      app = next
    },
    registerLifecycle(): void {
      beforeAll(async () => {
        const suite = await bootUnsealedRouteApp(initVault, passphrase)
        app = suite.app
        closeSuite = suite.close
      })
      afterAll(async () => {
        await closeSuite()
      })
    },
  }
}
