// Story 68.9 AC-5: the server modules known to read the internal API base URL, kept as data so a
// composed tree can merge its own additions and releases. The choke-point guard's RULE (no module
// pairs that URL with the raw global fetch) applies to every file and needs no entry; this list
// only feeds the anti-vacuous check that the scan really sees the known consumers.
export const BASE_INTERNAL_API_CONSUMERS: string[] = [
  'src/hooks.server.ts',
  'src/routes/api/v1/[...path]/+server.ts',
  'src/routes/ready/+server.ts',
  'src/routes/api/health/+server.ts',
  'src/routes/api/v1/auth/handoff/prepare/+server.ts',
  'src/routes/(auth)/handoff/+page.server.ts',
]

// The one module allowed to wrap the global fetch (Story 43.16): matched by path identity.
export const INTERNAL_API_CHOKE_POINT = 'src/lib/server/internal-api-tls.ts'
