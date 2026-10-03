// Story 68.9: this pack's guard entries. Data only: the kit validates it and merges it into the
// generated module PV's web guards read. An entry adds or releases a reviewed carve-out of a PV guard
// by exact path; it never limits what the pack may do.
import { defineGuardEntries } from '@project-vault/composition-kit'

export default defineGuardEntries({
  browserStorage: {
    sessionStorage: [
      {
        file: 'src/lib/billing-draft.ts',
        keys: ['cm:billing-draft'],
        reason: 'a non-sensitive billing draft id, never a credential or token',
      },
    ],
  },
  // Story 68-16: the entry shape of the runtime route audit's classification file.
  routeClassifications: [
    {
      route: 'GET /api/v1/cm/health',
      reason: 'public liveness probe, returns a static body',
      securityOwner: 'cm-platform',
      compensatingControls: ['no data is read', 'edge rate limit'],
    },
  ],
})
