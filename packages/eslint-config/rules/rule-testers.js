// Shared RuleTester setup for the rule tests (Story 66-17): one tester on the default parser and
// one on the TypeScript parser the repo uses for `.ts` files.
import { RuleTester } from 'eslint'
import tsParser from '@typescript-eslint/parser'
import { describe, it } from 'vitest'

RuleTester.describe = describe
RuleTester.it = it

const LANGUAGE_OPTIONS = { ecmaVersion: 'latest', sourceType: 'module' }

export const ruleTester = new RuleTester({ languageOptions: LANGUAGE_OPTIONS })

export const tsTester = new RuleTester({
  languageOptions: { parser: tsParser, ...LANGUAGE_OPTIONS },
})
