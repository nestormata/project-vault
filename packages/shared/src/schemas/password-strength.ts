import { ZxcvbnFactory } from '@zxcvbn-ts/core'
import * as zxcvbnCommonPackage from '@zxcvbn-ts/language-common'
import * as zxcvbnEnPackage from '@zxcvbn-ts/language-en'

// Story 1.21 Decision 1/Decision 3: configure zxcvbn-ts once at module load (mirroring the
// "configure once at module init" pattern already used for Argon2 params in
// apps/api/src/modules/auth/password.ts, even though this now lives in packages/shared) with the
// minimum viable dictionary/graph/translation set zxcvbn-ts's own docs recommend
// (language-common + language-en) — sufficient to catch the finding's concrete example
// (passwordpassword) and the broader length-padded-dictionary-word weak-password class.
//
// Deviation from the story's referenced External docs: `@zxcvbn-ts/core`'s v4.x public API
// dropped the singleton `zxcvbn()`/`zxcvbnOptions.setOptions()` functions the story's external
// reference describes (that shape belongs to zxcvbn-ts v2/v3) in favor of an instantiable
// `ZxcvbnFactory` class. The "configure once at module load" intent is preserved identically —
// a single factory instance is constructed here at module init and reused for every call — this
// is purely a v4 API-shape change, not a design deviation.
//
// AC-3 bundle-isolation note: this eager top-level construction is safe for apps/web's bundle
// ONLY because this module is imported exclusively by `auth.ts`'s `PasswordSchema`, and nothing
// else in `packages/shared` imports this module. Do not add an import of this module (directly or
// transitively) to any schema/file that a client-side bundle also needs — see the sibling
// `org-sso-domains.ts` split (moved out of `auth.ts` in this same story) for why: a single
// runtime-used export sharing a module with `PasswordSchema` would force this module's evaluation
// into that bundle too, `sideEffects: false` notwithstanding (the package flag lets a bundler drop
// an entire *unused* module, but it cannot partially evaluate a module that IS reachable).
const zxcvbnFactory = new ZxcvbnFactory({
  dictionary: {
    ...zxcvbnCommonPackage.dictionary,
    ...zxcvbnEnPackage.dictionary,
  },
  graphs: zxcvbnCommonPackage.adjacencyGraphs,
  translations: zxcvbnEnPackage.translations,
})

// Story 1.21 Decision 2: hardcoded, not an env var. zxcvbn's own documentation frames score 3
// ("safely unguessable — moderate protection against offline slow-hash scenario") as the
// recommended floor for an account password; OWASP's Authentication Cheat Sheet gives the same
// guidance. Unlike LOGIN_LOCKOUT_THRESHOLD (Story 1.22) or the Argon2 cost parameters — which are
// legitimate operational tuning knobs with no "correct" universal value — a password-strength
// floor is a fixed security baseline: making it operator-configurable would let an operator
// (accidentally or otherwise) weaken it below a safe value with no code review catching the
// drift, for no compensating benefit.
export const MIN_PASSWORD_STRENGTH_SCORE = 3

// Story 1.21 Decision 4 (Red Team vs Blue Team): score only the first 100 characters, not the
// full up-to-256-character string PasswordSchema otherwise allows. zxcvbn's pattern-matching is
// combinatorial and can be measurably slower on long, adversarially-constructed strings — capping
// the scored substring bounds the worst-case CPU cost on the unauthenticated /register path while
// still fully covering any realistic password's meaningful entropy (no legitimate password's
// meaningful entropy lives past 100 characters).
const MAX_SCORED_PASSWORD_LENGTH = 100

export function passwordMeetsStrengthRequirement(password: string): boolean {
  const scoredPassword = password.slice(0, MAX_SCORED_PASSWORD_LENGTH)
  const result = zxcvbnFactory.check(scoredPassword)
  return result.score >= MIN_PASSWORD_STRENGTH_SCORE
}
