import { describe, expect, it } from 'vitest'
import {
  CLI_MAX_REASON_CODE_POINTS,
  CLI_MAX_VERSION_LENGTH,
  CLI_MAX_WITHDRAWN_ENTRIES,
} from './cli-version-policy.js'
import * as shared from '../index.js'

// Story 43.13 AC-5 — the single definition of the pvault version-policy display caps, shared by
// the API (boot validation, re-exported to the CLI's parity test) and the web /version page.
// A change here is a deliberate cross-consumer contract change: keep these literal tripwires.
describe('CLI version-policy caps (Story 43.13 AC-5)', () => {
  it('pins the three caps', () => {
    expect(CLI_MAX_VERSION_LENGTH).toBe(128)
    expect(CLI_MAX_WITHDRAWN_ENTRIES).toBe(100)
    expect(CLI_MAX_REASON_CODE_POINTS).toBe(200)
  })

  it('is exported from the package index', () => {
    expect(shared.CLI_MAX_VERSION_LENGTH).toBe(CLI_MAX_VERSION_LENGTH)
    expect(shared.CLI_MAX_WITHDRAWN_ENTRIES).toBe(CLI_MAX_WITHDRAWN_ENTRIES)
    expect(shared.CLI_MAX_REASON_CODE_POINTS).toBe(CLI_MAX_REASON_CODE_POINTS)
  })
})
