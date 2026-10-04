import { baseRules } from '@project-vault/eslint-config'

export default [
  {
    // The UI pack's overlay tree (ui-pack/) is read by `pv-compose --pack` and typechecked only
    // inside the composed tree, so it is not linted here. Only the module pack under module/ is
    // workspace code.
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', '**/.stryker-tmp/**', 'ui-pack/**'],
  },
  ...baseRules,
]
