// Story 69.6: a contribution `load` at the PRE-AUTH point `auth.register.form`. It runs for an
// anonymous visitor (`locals.user` is absent), after PV's own load, and counts its runs so the e2e can
// prove it ran. With `?mock-p6-boom=<id>` it throws: the shipped contract (68-4) turns a throwing
// contribution into PV's own error response and logs `injection "<point>" load failed: <ErrorName>`
// (the error NAME only, never the message, which carries a secret-looking string on purpose).
let runs = 0

export const load = ({ locals, url }: { locals: { user?: unknown }; url: URL }) => {
  runs += 1
  if (url.searchParams.has('mock-p6-boom')) {
    throw new TypeError('mock-ui-pack-secret-message')
  }
  return { runs, session: locals.user ? 'present' : 'none' }
}
