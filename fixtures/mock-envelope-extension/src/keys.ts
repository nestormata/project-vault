/**
 * Story 23.2 AC-14/AC-15: this fixture's own generated Ed25519 keypair — asymmetric
 * verification only (never a shared HMAC secret), matching the "never in production" fixture
 * discipline. Generated once via `node -e "require('crypto').generateKeyPairSync('ed25519', ...)"`
 * and committed here.
 *
 * **THIS PRIVATE KEY IS TEST-ONLY AND PUBLIC IN THIS REPOSITORY.** It signs nothing that ever
 * reaches a real credential, session, or production system — it exists solely so this fixture's
 * own tests (and a manual-QA operator following the README) can mint envelopes to feed to
 * `onAuthenticate()`. Never reuse it, never treat a token it signs as meaningful outside this
 * fixture's own test suite.
 */
export const FIXTURE_TEST_ONLY_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIKOLvMAl5eNOu1BdJ+AL6jjYhD8xgvtWpchKG790e8OV
-----END PRIVATE KEY-----`

/** The public half of the same test-only keypair — this is what `onAuthenticate()`'s default
 * `getVerificationKey()` verifies against. Safe to be public; only the private key is sensitive
 * (and even that is only sensitive in the "don't confuse it for a real secret" sense, not in the
 * "this protects anything real" sense). */
export const FIXTURE_TEST_ONLY_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEALOk74iIBia5I9V6wZHJR8W3cV83dTUuzg/+iJAoymBw=
-----END PUBLIC KEY-----`
