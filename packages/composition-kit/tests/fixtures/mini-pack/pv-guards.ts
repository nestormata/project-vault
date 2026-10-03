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
})
