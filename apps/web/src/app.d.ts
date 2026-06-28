import type { AuthUser } from '$lib/api/auth.js'

declare global {
  namespace App {
    interface Locals {
      user: AuthUser | null
    }
  }
}

export {}
