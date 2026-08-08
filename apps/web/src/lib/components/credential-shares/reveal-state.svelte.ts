import type { ShareRevealValueFormat } from '$lib/api/credential-shares.js'

/** Shared by both reveal pages (17.1's session-bound `/shares/[token]` and 17.2's
 *  unauthenticated `/external-shares/[token]`) — both pages track the exact same
 *  revealing/revealedValue/revealError triad for their two-step reveal button, differing only in
 *  which terminal error reasons their own API call can produce (17.1 alone can hit 403
 *  'ineligible'). `E` is the caller's own error-reason union. */
export function createShareRevealState<E extends string>() {
  let revealing = $state(false)
  let revealedValue = $state<string | null>(null)
  let revealedValueFormat = $state<ShareRevealValueFormat>('scalar')
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
    get revealedValueFormat() {
      return revealedValueFormat
    },
    set revealedValueFormat(value: ShareRevealValueFormat) {
      revealedValueFormat = value
    },
    get revealError() {
      return revealError
    },
    set revealError(value: E | null) {
      revealError = value
    },
  }
}

export type ShareRevealState<E extends string> = ReturnType<typeof createShareRevealState<E>>

export async function revealShareValue<E extends string>(
  state: ShareRevealState<E>,
  request: () => Promise<{ value: string; valueFormat?: ShareRevealValueFormat }>,
  mapError: (error: unknown) => E
): Promise<void> {
  if (state.revealing) return
  state.revealing = true
  state.revealError = null
  try {
    const result = await request()
    state.revealedValue = result.value
    state.revealedValueFormat = result.valueFormat ?? 'scalar'
  } catch (error) {
    state.revealError = mapError(error)
  } finally {
    state.revealing = false
  }
}
