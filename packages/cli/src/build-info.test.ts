import { describe, expect, it } from 'vitest'
import { AGENT_BUILD_INFO } from '@project-vault/agent/build-info'
import { CLI_BUILD_INFO, formatVersionOutput, PVAULT_RELEASES_URL } from './build-info.js'

describe('build-info (Story 43.6 AC-4, D2)', () => {
  it('the committed CLI and agent build-info are the unstamped dev defaults', () => {
    expect(CLI_BUILD_INFO).toEqual({ version: 'dev', commit: null })
    expect(AGENT_BUILD_INFO).toEqual({ version: 'dev', commit: null })
  })

  it('the download URL is the baked constant', () => {
    expect(PVAULT_RELEASES_URL).toBe('https://github.com/nestormata/project-vault/releases')
  })
})

describe('formatVersionOutput', () => {
  it('renders a stamped release as two stdout lines and no stderr', () => {
    const info = { version: '1.3.0', commit: '3f2a1c9' }
    expect(formatVersionOutput(info, info)).toEqual({
      stdout: 'pvault 1.3.0 (commit 3f2a1c9)\nagent  1.3.0 (commit 3f2a1c9)\n',
      stderr: '',
    })
  })

  it('renders an unstamped dev build', () => {
    const info = { version: 'dev', commit: null }
    expect(formatVersionOutput(info, info).stdout).toBe(
      'pvault dev (commit unknown)\nagent  dev (commit unknown)\n'
    )
  })

  it('the second token of line 1 is the CLI version (stable scripting format)', () => {
    const out = formatVersionOutput(
      { version: '1.3.0', commit: '3f2a1c9' },
      { version: '1.3.0', commit: '3f2a1c9' }
    )
    expect(out.stdout.split('\n')[0]?.split(' ')[1]).toBe('1.3.0')
  })

  it.each([
    [
      { version: '1.3.0', commit: '3f2a1c9' },
      { version: '1.2.0', commit: '3f2a1c9' },
    ],
    [
      { version: '1.3.0', commit: '3f2a1c9' },
      { version: '1.3.0', commit: 'aaaaaaa' },
    ],
    [
      { version: 'dev', commit: null },
      { version: '1.3.0', commit: '3f2a1c9' },
    ],
  ])('surfaces skew on stderr only (%j vs %j)', (cli, agent) => {
    const out = formatVersionOutput(cli, agent)
    expect(out.stderr).toBe(
      'warning: pvault and its agent were built from different sources; rebuild both (pnpm --filter "@project-vault/cli..." build)\n'
    )
    expect(out.stdout).not.toContain('warning')
  })

  it('never contains 0.0.1', () => {
    const info = { version: 'dev', commit: null }
    expect(JSON.stringify(formatVersionOutput(info, info))).not.toContain('0.0.1')
  })
})
