import { ApiClientError } from './client.js'

/** Shared by both reveal pages (17.1's session-bound `/shares/[token]` and 17.2's unauthenticated
 *  `/external-shares/[token]`) — both map a 410 reveal failure to the same terminal reasons. */
export type ShareRevealErrorReason = 'expired' | 'already_viewed' | 'revoked' | 'other'

export function mapShareRevealError(error: unknown): ShareRevealErrorReason {
  if (error instanceof ApiClientError && error.status === 410) {
    if (error.code === 'share_already_viewed') return 'already_viewed'
    if (error.code === 'share_revoked') return 'revoked'
    return 'expired'
  }
  return 'other'
}
