import { beforeEach } from 'vitest'

const DEFAULT_DATABASE_URL =
  'postgresql://vault_app:dev-only-change-in-prod@localhost:5432/project_vault'
// Tests that exercise a real admin query must provide ADMIN_DATABASE_URL explicitly.
// The default is intentionally non-connectable so the harness cannot launder a local
// superuser into a passing test.
const DEFAULT_ADMIN_DATABASE_URL = 'postgresql://vault_admin@admin-db.invalid:5432/project_vault'

// Story 23.2 AC-6e item 3: the boot check added to native-login-policy.ts fails startup when
// env.AUTH_DUMMY_PASSWORD_HASH still equals the in-repo DEV_AUTH_DUMMY_PASSWORD_HASH default AND
// the resolved policy is anything other than plain 'enabled' — many test files legitimately
// resolve a declared/proven/disabled/break_glass policy in-process without caring about AC-6e at
// all. Setting a distinct-but-still-valid dummy hash globally here (same Argon2 params as the
// default so validateDummyPasswordHash's params-match check still passes, different salt/digest
// bytes so it is never equal to DEV_AUTH_DUMMY_PASSWORD_HASH) keeps that boot check dormant for
// the whole suite by default, exactly as it should be in real deployments once an operator has
// set the var — a test that specifically wants to exercise the boot check unsets or overrides
// this value itself (see native-login-policy.test.ts).
const DEFAULT_TEST_AUTH_DUMMY_PASSWORD_HASH = [
  '$argon2id$v=19$m=65536,t=3,p=4',
  'dGVzdC1zdWl0ZS1vbmx5LXNhbHQ',
  // base64 test-fixture bytes, not a credential — this hash is never a real password (see the
  // comment above the const).
  // eslint-disable-next-line no-secrets/no-secrets
  'dGVzdC1zdWl0ZS1vbmx5LWRpZ2VzdC1ub3QtcHJvZHVjdGlvbg',
].join('$')

process.env['DATABASE_URL'] ??= DEFAULT_DATABASE_URL
process.env['ADMIN_DATABASE_URL'] ??= DEFAULT_ADMIN_DATABASE_URL
process.env['AUTH_DUMMY_PASSWORD_HASH'] ??= DEFAULT_TEST_AUTH_DUMMY_PASSWORD_HASH
// Story 22.5 Task 1 (regression trap): env.ts's AUDIT_ORG_QUOTA_ENFORCEMENT_ENABLED default
// flips to true in this story. ~40+ existing test files across the suite implicitly rely on the
// old `false` default and never set this var themselves. Pin it to `false` here so the flip is
// never observed by a test that isn't deliberately exercising the ON state (those files set/stub
// this var explicitly and are unaffected by this pin).
process.env['AUDIT_ORG_QUOTA_ENFORCEMENT_ENABLED'] ??= 'false'

beforeEach(() => {
  process.env['DATABASE_URL'] ??= DEFAULT_DATABASE_URL
  process.env['ADMIN_DATABASE_URL'] ??= DEFAULT_ADMIN_DATABASE_URL
  process.env['AUTH_DUMMY_PASSWORD_HASH'] ??= DEFAULT_TEST_AUTH_DUMMY_PASSWORD_HASH
  process.env['AUDIT_ORG_QUOTA_ENFORCEMENT_ENABLED'] ??= 'false'
})
