// Story 69.3: a contribution `load` at the region point `status.detail.services`, run through the
// public status route's behavior table (the pack opted in with `hostRoutes`). PV runs it ONLY for a
// valid token (an invalid, disabled or sealed token skips every contribution load), and it runs with
// no session: `user` reports whether `locals.user` was present (it must not be). `runs` counts the
// loads this server process ran, so the e2e can prove an invalid token ran none. The result is
// serialized into public HTML and `__data.json`: a counter and a literal only, never the token.
let runs = 0

export const load = ({ locals }: { locals: { user?: unknown } }) => {
  runs += 1
  return { runs, user: locals.user ? 'present' : 'none' }
}
