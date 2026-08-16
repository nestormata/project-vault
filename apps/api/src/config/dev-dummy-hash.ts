/**
 * Story 23.2 AC-6e item 3: the in-repo, publicly-known default value of `AUTH_DUMMY_PASSWORD_HASH`
 * — split out of `env.ts` into its own module (rather than exported from there) specifically so
 * `native-login-policy.ts`'s boot check can import it without depending on `config/env.js`.
 * A dozen existing test files `vi.mock('../config/env.js', () => ({ env: {...} }))` with a
 * partial mock that has no reason to know about this constant; requiring every one of them to
 * also export it (or crash on `createApp()`) would have been a wide, brittle blast radius for an
 * AC-6e-specific concern. This file is never mocked by any of them, so it needs no such fix.
 */
export const DEV_AUTH_DUMMY_PASSWORD_HASH = [
  '$argon2id$v=19$m=65536,t=3,p=4',
  'c/PLdA7Wvhkg8hPqLu5AlQ',
  ['7zS8GhNt', 'QTJsiMmJ', 'LErN9kM1', '9VoNBM3P', 'HV3OhidvHtY'].join(''),
].join('$')
