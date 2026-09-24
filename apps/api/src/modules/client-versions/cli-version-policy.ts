import type { BakedCliVersionPolicy } from './policy.js'

/**
 * Story 43.6 (decision D5) — the upstream CLI version policy, shipped with each server release.
 * Operators can only tighten it (`CLI_MINIMUM_SUPPORTED_VERSION`, `CLI_WITHDRAWN_VERSIONS`); they
 * can never un-withdraw a version listed here. Each reason is fixed, printable ASCII (1-200
 * characters, enforced by cli-version-policy.test.ts) because it is served on a public endpoint
 * and printed in users' terminals.
 *
 * When changing this list, add a "CLI" line under the release notes' Upgrade notes.
 */
export const BAKED_CLI_VERSION_POLICY: BakedCliVersionPolicy = {
  minimumSupported: null,
  withdrawn: [],
}
