/** Shared by both reveal pages (17.1's session-bound `/shares/[token]` and 17.2's
 *  unauthenticated `/external-shares/[token]`) — both pages track the exact same
 *  revealing/revealedValue/revealError triad for their two-step reveal button, differing only in
 *  which terminal error reasons their own API call can produce (17.1 alone can hit 403
 *  'ineligible'). `E` is the caller's own error-reason union. */
export function createShareRevealState<E extends string>() {
  let revealing = $state(false)
  let revealedValue = $state<string | null>(null)
  let revealError = $state<E | null>(null)

  return {
    get revealing() {
      return revealing
    },
    set revealing(value: boolean) {
      revealing = value
    },
    get revealedValue() {
      return revealedValue
    },
    set revealedValue(value: string | null) {
      revealedValue = value
    },
    get revealError() {
      return revealError
    },
    set revealError(value: E | null) {
      revealError = value
    },
  }
}
