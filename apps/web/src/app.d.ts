import type { AuthUser } from '$lib/api/auth.js'

declare global {
  namespace App {
    interface Locals {
      user: AuthUser | null
    }
    // Story 68.4: server data contributed to injection points, keyed by point name, one entry per
    // contribution at that point (see `$lib/server/composition/inject-behavior.ts`).
    interface PageData {
      __inject?: Record<string, readonly unknown[]>
    }
  }
}

export {}
