/**
 * Story 43.5 AC-7 — the "non-CLI caller" test. Imports ONLY `writeEnvFile` and the shared format
 * module (never `cli.ts`, `buildProgram`, commander, or `@project-vault/agent`) and calls it with a
 * hand-built entry list and an in-memory `getSecret`, exactly as a future Epic 50 broker
 * (FR177's `write_env_file`) would. Mirrors `inject-and-run.non-cli-caller.test.ts`: a structural
 * proof, since Epic 50 has zero implementation stories today.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseEnvFile } from './env-file-format.js'
import { writeEnvFile } from './write-env-file.js'

describe('writeEnvFile as a non-CLI caller (Epic 50 seam proof)', () => {
  it('a hand-built caller with no CLI involvement writes a file its own reader can parse', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pvault-broker-'))
    try {
      const secretStore: Record<string, string> = { 'deploy token': 'broker-fetched\nvalue' }
      const getSecret = async (name: string): Promise<string> => {
        const value = secretStore[name]
        if (value === undefined) throw new Error(`unknown secret: ${name}`)
        return value
      }

      const target = join(dir, 'broker.env')
      const result = await writeEnvFile(
        [{ credentialName: 'deploy token', envVarName: 'DEPLOY_TOKEN' }],
        target,
        { format: 'dotenv', force: false },
        { getSecret }
      )

      expect(result).toEqual({
        ok: true,
        exitCode: 0,
        path: target,
        count: 1,
        servedFromCacheCount: 0,
      })
      expect(parseEnvFile(readFileSync(target, 'utf8'), 'dotenv')).toEqual([
        { key: 'DEPLOY_TOKEN', value: 'broker-fetched\nvalue' },
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
