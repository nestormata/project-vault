import * as core from '@actions/core'
import { run } from './run.js'

try {
  await run()
} catch (error: unknown) {
  // Should be unreachable — run() itself catches every error condition this action's own spec
  // documents. This is a last-resort guard so an unforeseen bug never surfaces to a workflow
  // author as a raw, unhandled Node stack trace instead of a clean, actionable failure message.
  core.setFailed(
    `vault-action: unexpected internal error: ${error instanceof Error ? error.message : String(error)}`
  )
}
