// Story 69.6: a contribution `load` at `platform.home.nav-cards`. PV skips every contribution load
// for a caller its own load flagged `allowed: false`, so a non-operator never reaches this function:
// `runs` is the counter the e2e reads before and after a denied request. The fill still authorizes on
// its own (it reads the caller's own profile through PV's `event.fetch` and tolerates a non-JSON answer).
let runs = 0

export const load = async ({ fetch }: { fetch: typeof globalThis.fetch }) => {
  runs += 1
  const me = await fetch('/api/v1/auth/me')
  const body = (await me.json().catch(() => ({}))) as { data?: { isPlatformOperator?: boolean } }
  return { runs, operator: body.data?.isPlatformOperator === true ? 'yes' : 'no' }
}
