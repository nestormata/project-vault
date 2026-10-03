import type { PageServerLoad } from './$types.js'
// Both imports name PV's modules; Story 68.5's `pvReplace` hands back CM's replacements. The first
// is spelled `.js` for the `.ts` file, the way PV writes it.
import type { AuthUser } from '$lib/api/auth.js'
import { auditExportDownloadUrl } from '$lib/api/audit.js'
import { requireUser } from '$lib/server/require-user.js'

// A signed-in owner whose MFA is settled, spelled the way CentralizeMe's own session would be.
const MFA_SETTLED: AuthUser['mfaStatus'] = {
  bannerMessage: null,
  enrollmentRequired: false,
  gracePeriodActive: false,
  gracePeriodDaysRemaining: null,
  gracePeriodExpiresAt: null,
}

const OWNER: AuthUser = {
  orgName: 'Acme Inc',
  orgRole: 'owner',
  orgId: 'org-1',
  userId: 'user-1',
  sessionId: 'session-1',
  isPlatformOperator: false,
  mfaEnrolled: false,
  mfaEnrolledAt: null,
  remainingRecoveryCodesCount: null,
  mfaStatus: MFA_SETTLED,
}

export const load: PageServerLoad = () => ({
  download: auditExportDownloadUrl('job-1'),
  user: requireUser({ user: OWNER }),
})
