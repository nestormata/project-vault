// Story 66-6 fixture variant: the index imports a src file that uses a Node global. The
// generator builds with `types: []`, so the helper must fail the generation closed.
import './helper.js'

export interface Id {
  readonly value: string
}
