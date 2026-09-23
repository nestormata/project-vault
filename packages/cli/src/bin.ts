#!/usr/bin/env node
import { runCli } from './cli.js'
import { hardenProcessDiagnostics } from './inject-and-run.js'

// Story 43.4 AC-1 — before anything fetches a secret, stop Node diagnostic reports (which would dump
// this process's full environment, including VAULT_API_KEY, to disk) from ever being written.
hardenProcessDiagnostics(process)
await runCli(process.argv)
