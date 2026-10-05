import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/svelte'
import { routeExists } from '$lib/test/route-exists.js'
import type { CliVersionPolicy, CliVersionPolicyResult } from '$lib/api/platform.js'

import type { ComponentProps } from 'svelte'
import { appLayoutData, deniedPageData } from '$lib/test/page-data.js'
import UpgradePage from './+page.svelte'

afterEach(() => cleanup())

type AllowedData = Extract<ComponentProps<typeof UpgradePage>['data'], { allowed: true }>

function allowedData(overrides: Partial<AllowedData> = {}): AllowedData {
  return {
    ...appLayoutData(),
    allowed: true,
    version: '0.9.0',
    versionSource: 'release' as const,
    apiDocsEnabled: false,
    // Story 43.7: a consistent release policy by default. (Not the dev-build policy: its
    // "development build" copy would collide with the 9.10 assertions below, which stay unchanged.)
    cliPolicy: okPolicy(),
    ...overrides,
  }
}

const here = dirname(fileURLToPath(import.meta.url))
const ADMIN_REASON = "Withdrawn by this server's administrator."
const RUNBOOK_URL =
  'https://github.com/nestormata/project-vault/blob/main/docs/runbooks/cli-version-policy.md'

const DEV_POLICY_OK: CliVersionPolicyResult = {
  status: 'ok',
  policy: {
    server: { version: 'dev', versionSource: 'development' },
    cli: { current: null, minimumSupported: null, withdrawn: [] },
  },
}

function okPolicy(
  cli: Partial<CliVersionPolicy['cli']> = {},
  server: CliVersionPolicy['server'] = { version: '1.3.0', versionSource: 'release' }
): CliVersionPolicyResult {
  return {
    status: 'ok',
    policy: {
      server,
      cli: {
        current: '1.3.0',
        minimumSupported: '1.1.0',
        withdrawn: [{ version: '1.2.1', reason: ADMIN_REASON }],
        ...cli,
      },
    },
  }
}

/** Collapse the whitespace Prettier's line wrapping leaves inside long copy. */
function norm(element: Element | null) {
  return (element?.textContent ?? '').replace(/\s+/g, ' ')
}

function renderPolicy(cliPolicy: CliVersionPolicyResult) {
  return render(UpgradePage, { props: { data: allowedData({ cliPolicy }) } })
}

function policySection() {
  const heading = screen.getByRole('heading', { name: 'CLI Version Policy' })
  const section = heading.closest('section')
  if (!section) throw new Error('CLI Version Policy heading is not inside a <section>')
  return section
}

function withdrawnRows() {
  const table = screen.getByRole('table', { name: /withdrawn pvault versions/i })
  const [, ...bodyRows] = within(table).getAllByRole('row')
  return bodyRows.map((row) =>
    within(row)
      .getAllByRole('cell')
      .map((cell) => norm(cell).trim())
  )
}

describe('/platform/upgrade +page.svelte', () => {
  it('is a real, existing route', () => {
    expect(routeExists('/platform/upgrade')).toBe(true)
  })

  it('a non-operator sees the platform-operator-required notice', () => {
    render(UpgradePage, { props: { data: deniedPageData() } })

    expect(screen.getByRole('heading', { name: /platform operator access required/i })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: /current version/i })).toBeNull()
  })

  it('shows the running version when present', () => {
    render(UpgradePage, { props: { data: allowedData({ version: '1.2.3' }) } })

    expect(screen.getByText(/running version/i).textContent).toMatch(/1\.2\.3/)
  })

  it('edge: shows a fallback message when version is unavailable', () => {
    render(UpgradePage, {
      props: { data: allowedData({ version: null, versionSource: null }) },
    })

    expect(screen.getByText(/version information unavailable/i)).toBeTruthy()
  })

  // Story 9.10 AC-1/AC-3: the page must identify whether the running version is a release or a
  // development build, never silently presenting a dev build as a production release.
  describe('Story 9.10: versionSource', () => {
    it('AC-1: labels a real release build as "release"', () => {
      render(UpgradePage, {
        props: { data: allowedData({ version: '1.0.2', versionSource: 'release' }) },
      })

      expect(screen.getByText(/release build/i)).toBeTruthy()
    })

    it('AC-1: labels the dev-fallback build as "development", not a release', () => {
      render(UpgradePage, {
        props: { data: allowedData({ version: 'dev', versionSource: 'development' }) },
      })

      expect(screen.getByText(/development build/i)).toBeTruthy()
      // Unanchored: the rendered copy is a full sentence ("This is a release build."), so an
      // anchored /^release build$/ could never match any node and would pass vacuously.
      expect(screen.queryByText(/this is a release build/i)).toBeNull()
    })

    it('AC-3 edge: shows an honest unknown state when versionSource is unavailable', () => {
      render(UpgradePage, {
        props: { data: allowedData({ version: null, versionSource: null }) },
      })

      expect(screen.getByText(/version information unavailable/i)).toBeTruthy()
      expect(screen.queryByText(/release build/i)).toBeNull()
      expect(screen.queryByText(/development build/i)).toBeNull()
    })

    it('AC-3 edge: shows an honest unknown build type when a version is present but versionSource is not', () => {
      render(UpgradePage, {
        props: { data: allowedData({ version: '1.2.3', versionSource: null }) },
      })

      expect(screen.getByText(/build type unknown/i)).toBeTruthy()
      expect(screen.queryByText(/release build/i)).toBeNull()
      expect(screen.queryByText(/development build/i)).toBeNull()
    })
  })

  it('shows the API docs disabled message and no Swagger link when apiDocsEnabled is false', () => {
    render(UpgradePage, { props: { data: allowedData({ apiDocsEnabled: false }) } })

    expect(screen.getByText(/not enabled on this instance/i)).toBeTruthy()
    expect(screen.queryByRole('link', { name: /open api documentation/i })).toBeNull()
  })

  it('shows a working Swagger UI link when apiDocsEnabled is true', () => {
    render(UpgradePage, { props: { data: allowedData({ apiDocsEnabled: true }) } })

    const link = screen.getByRole('link', { name: /open api documentation/i })
    expect(link.getAttribute('href')).toBe('/api/v1/docs')
    expect(screen.queryByText(/not enabled on this instance/i)).toBeNull()
  })

  it('the Platform Admin breadcrumb link resolves to a real route', () => {
    render(UpgradePage, { props: { data: allowedData() } })

    const link = screen.getByRole('link', { name: /platform admin/i })
    expect(routeExists(link.getAttribute('href') ?? '')).toBe(true)
  })

  // Story 43.7: the CLI Version Policy section.
  describe('Story 43.7: CLI Version Policy section', () => {
    it('AC-1: sits between Current Version and Upgrade Procedure', () => {
      renderPolicy(okPolicy())

      const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)
      expect(headings).toEqual([
        'Current Version',
        'CLI Version Policy',
        'Upgrade Procedure',
        'API Documentation',
      ])
      expect(
        within(policySection()).getByText(
          /what this server tells pvault command-line clients when they check their version/i
        )
      ).toBeTruthy()
    })

    it('AC-1: renders current, minimum, withdrawn row, D5 note and footnote for a release policy', () => {
      renderPolicy(okPolicy())

      const current = screen.getByTestId('cli-policy-current')
      expect(current.querySelector('code')?.textContent).toBe('1.3.0')
      expect(norm(current)).toMatch(/pvault older than this prints a notice at most once a day/i)
      expect(norm(current)).toMatch(/pvault newer than this is told the server is older/i)

      const minimum = screen.getByTestId('cli-policy-minimum')
      expect(minimum.querySelector('code')?.textContent).toBe('1.1.0')
      expect(norm(minimum)).toMatch(/prints a warning but keeps working/i)

      expect(withdrawnRows()).toEqual([['1.2.1', ADMIN_REASON]])
      const withdrawn = screen.getByTestId('cli-policy-withdrawn')
      expect(norm(withdrawn)).toMatch(
        /these exact versions refuse to run \(exit code 29\) before requesting any secret/i
      )
      expect(norm(withdrawn)).toMatch(/PVAULT_NO_VERSION_CHECK does not bypass this/)
      expect(norm(withdrawn)).toMatch(
        /entries with this reason were added through CLI_WITHDRAWN_VERSIONS on this server/i
      )

      const section = policySection()
      expect(norm(section)).toMatch(/the api reads this policy at startup/i)
      expect(norm(section)).toMatch(/pvault caches it for up to 1 hour/i)
      const link = within(section).getByRole('link', { name: /cli version policy runbook/i })
      expect(link.getAttribute('href')).toBe(RUNBOOK_URL)
      expect(link.getAttribute('target')).toBe('_blank')
      expect(link.getAttribute('rel')).toBe('noopener noreferrer')
    })

    it('AC-1: the table has a caption, column headers and <bdi> reasons; values are wrapped safely', () => {
      renderPolicy(okPolicy())

      const table = screen.getByRole('table', { name: /withdrawn pvault versions/i })
      const headers = within(table).getAllByRole('columnheader')
      expect(headers.map((h) => h.textContent)).toEqual(['Version', 'Reason'])
      expect(headers.every((h) => h.getAttribute('scope') === 'col')).toBe(true)
      const [, reasonCell] = within(table).getAllByRole('cell')
      expect(reasonCell?.querySelector('bdi')?.textContent).toBe(ADMIN_REASON)
      expect(reasonCell?.className).toMatch(/break-words/)
      expect(table.querySelector('code')?.className).toMatch(/break-all/)
      expect(table.parentElement?.className).toMatch(/overflow-x-auto/)
      expect(screen.getByTestId('cli-policy-current').querySelector('code')?.className).toMatch(
        /break-all/
      )
    })

    it('AC-1: withdrawn rows keep the server order and duplicates, no re-sorting', () => {
      renderPolicy(
        okPolicy({
          withdrawn: [
            { version: '1.2.1', reason: 'a' },
            { version: '1.0.0-rc.2', reason: 'b' },
            { version: '0.9.9', reason: 'c' },
            { version: '0.9.9', reason: 'c' },
          ],
        })
      )

      expect(withdrawnRows()).toEqual([
        ['1.2.1', 'a'],
        ['1.0.0-rc.2', 'b'],
        ['0.9.9', 'c'],
        ['0.9.9', 'c'],
      ])
    })

    it('AC-1: the D5 note is hidden when no reason is the administrator reason', () => {
      renderPolicy(okPolicy({ withdrawn: [{ version: '1.0.0', reason: 'Known-bad build.' }] }))

      expect(screen.queryByText(/added through CLI_WITHDRAWN_VERSIONS/i)).toBeNull()
    })

    it('AC-1: a dev server shows the development copy, no minimum, nothing withdrawn, no table', () => {
      renderPolicy(DEV_POLICY_OK)

      expect(norm(screen.getByTestId('cli-policy-current'))).toMatch(
        /not advertised — this server is a development build, so pvault shows no out-of-date notices/i
      )
      expect(norm(screen.getByTestId('cli-policy-minimum'))).toMatch(
        /no minimum supported version is configured/i
      )
      expect(norm(screen.getByTestId('cli-policy-withdrawn'))).toMatch(
        /no pvault versions are withdrawn/i
      )
      expect(screen.queryByRole('table')).toBeNull()
      expect(norm(policySection())).toMatch(/the api reads this policy at startup/i)
    })

    it('AC-1: a non-strict release names the raw version and never says "development build"', () => {
      renderPolicy(
        okPolicy({ current: null }, { version: '1.3.0-hotfix2', versionSource: 'release' })
      )

      const current = screen.getByTestId('cli-policy-current')
      expect(norm(current)).toMatch(/not a plain x\.y\.z version/i)
      expect(norm(current)).toContain('1.3.0-hotfix2')
      expect(norm(current)).not.toMatch(/development build/i)
    })

    it('AC-1: HTML-looking reasons render as literal text; U+202E stays inside <bdi>', () => {
      const reasons = [
        '<script>alert(1)</script>',
        '<img src=x onerror=alert(1)>',
        '&amp;',
        'a\u202Eb',
      ]
      renderPolicy(
        okPolicy({ withdrawn: reasons.map((reason, i) => ({ version: `1.0.${i}`, reason })) })
      )

      expect(withdrawnRows().map((row) => row[1])).toEqual(reasons)
      const section = policySection()
      expect(section.querySelector('script')).toBeNull()
      expect(section.querySelector('img')).toBeNull()
      const bdis = [...section.querySelectorAll('bdi')].map((b) => b.textContent)
      expect(bdis).toContain('a\u202Eb')
    })

    it('AC-1: an empty or whitespace-only reason renders "(no reason given)"', () => {
      renderPolicy(
        okPolicy({
          withdrawn: [
            { version: '1.0.0', reason: '' },
            { version: '1.0.1', reason: '   ' },
          ],
        })
      )

      expect(withdrawnRows()).toEqual([
        ['1.0.0', '(no reason given)'],
        ['1.0.1', '(no reason given)'],
      ])
    })

    it('AC-1: server values never land in attributes; the only link is the constant runbook', () => {
      const marker = 'MARKER-1.2.1'
      renderPolicy(
        okPolicy({
          current: 'MARKER-cur',
          minimumSupported: 'MARKER-min',
          withdrawn: [{ version: marker, reason: 'MARKER-reason' }],
        })
      )

      const section = policySection()
      for (const element of section.querySelectorAll('*')) {
        for (const attribute of element.attributes) {
          expect(attribute.value).not.toContain('MARKER')
        }
      }
      const links = within(section).getAllByRole('link')
      expect(links.map((link) => link.getAttribute('href'))).toEqual([RUNBOOK_URL])
      expect(section.textContent?.match(/MARKER-reason/g)).toHaveLength(1)
    })

    it('AC-1: 100 withdrawn entries render as 100 rows, no pagination', () => {
      renderPolicy(
        okPolicy({
          withdrawn: Array.from({ length: 100 }, (_, i) => ({ version: `1.0.${i}`, reason: 'x' })),
        })
      )

      expect(withdrawnRows()).toHaveLength(100)
    })

    it('AC-1: long values render in full', () => {
      const longVersion = `1.0.0-${'a'.repeat(122)}`
      const longReason = 'r'.repeat(200)
      renderPolicy(okPolicy({ withdrawn: [{ version: longVersion, reason: longReason }] }))

      expect(withdrawnRows()).toEqual([[longVersion, longReason]])
    })

    it('AC-4: shows the warning box with both lines, in order, above the values', () => {
      renderPolicy(
        okPolicy({
          current: '1.3.0',
          minimumSupported: '1.4.0',
          withdrawn: [{ version: '1.3.0', reason: 'x' }],
        })
      )

      const warning = screen.getByTestId('cli-policy-warning')
      expect(warning.getAttribute('role')).toBe('note')
      const lines = [...warning.querySelectorAll('li')].map((li) => li.textContent)
      expect(lines).toHaveLength(2)
      expect(lines[0]).toMatch(
        /the minimum supported version \(1\.4\.0\) is above this server's release \(1\.3\.0\)/i
      )
      expect(lines[1]).toMatch(/this server's own release \(1\.3\.0\) is in the withdrawn list/i)
      const current = screen.getByTestId('cli-policy-current')
      expect(
        warning.compareDocumentPosition(current) & Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy()
    })

    it('AC-4: no warning box for a consistent policy', () => {
      renderPolicy(okPolicy())

      expect(screen.queryByTestId('cli-policy-warning')).toBeNull()
    })

    const UNAVAILABLE: [string, RegExp][] = [
      ['not_supported', /this api version does not publish a cli version policy/i],
      ['rate_limited', /the cli version policy is temporarily unavailable \(rate limited\)/i],
      ['api_unavailable', /could not be loaded because the api is unavailable/i],
      ['timeout', /the cli version policy did not load in time/i],
      ['invalid_response', /returned a cli version policy this page could not read/i],
      ['error', /^the cli version policy could not be loaded\.$/i],
    ]

    it.each(UNAVAILABLE)('AC-3: %s → its one honest message, no values', (reason, message) => {
      renderPolicy({ status: 'unavailable', reason } as CliVersionPolicyResult)

      const section = policySection()
      expect(within(section).getByText(/what this server tells pvault/i)).toBeTruthy()
      const status = within(section).getByRole('status')
      expect(within(status).getByText(message)).toBeTruthy()
      for (const [otherReason, otherMessage] of UNAVAILABLE) {
        if (otherReason !== reason) expect(within(section).queryByText(otherMessage)).toBeNull()
      }
      expect(screen.queryByTestId('cli-policy-current')).toBeNull()
      expect(screen.queryByTestId('cli-policy-minimum')).toBeNull()
      expect(screen.queryByTestId('cli-policy-withdrawn')).toBeNull()
      expect(screen.queryByTestId('cli-policy-warning')).toBeNull()
      // The critical honesty check: an outage never reads as "nothing is withdrawn".
      expect(screen.queryByText(/no pvault versions are withdrawn/i)).toBeNull()
      expect(norm(section)).not.toMatch(/the api reads this policy at startup/i)
      expect(section.querySelector('[role="alert"]')).toBeNull()
      const runbook = within(section).queryByRole('link', { name: /cli version policy runbook/i })
      if (reason === 'not_supported') {
        expect(runbook?.getAttribute('href')).toBe(RUNBOOK_URL)
      } else {
        expect(runbook).toBeNull()
      }
    })

    it('AC-3: the rate-limited message explains the shared per-address budget', () => {
      renderPolicy({ status: 'unavailable', reason: 'rate_limited' })

      expect(norm(policySection())).toMatch(
        /the api allows 60 policy requests per minute per client address, and requests from this web app all count as one address/i
      )
    })

    it('AC-3: an unexpected reason (forced cast) falls back to the generic error message, never interpolated', () => {
      renderPolicy({
        status: 'unavailable',
        reason: '<b>INJECTED</b>',
      } as unknown as CliVersionPolicyResult)

      const section = policySection()
      expect(
        within(section).getByText(/^the cli version policy could not be loaded\.$/i)
      ).toBeTruthy()
      expect(norm(section)).not.toContain('INJECTED')
    })

    it('AC-5: a non-operator sees no CLI Version Policy heading', () => {
      render(UpgradePage, { props: { data: deniedPageData() } })

      expect(screen.queryByRole('heading', { name: /cli version policy/i })).toBeNull()
    })

    it('AC-1: neither the page nor the section component uses {@html', () => {
      // Story 69.5: the page's markup lives in its region component.
      const page = readFileSync(
        resolve(here, '../../../../lib/components/platform/PlatformUpgradeContent.svelte'),
        'utf-8'
      )
      const section = readFileSync(
        resolve(here, '../../../../lib/components/platform/CliVersionPolicySection.svelte'),
        'utf-8'
      )
      expect(page).toContain('CliVersionPolicySection')
      expect(page).not.toContain('{@html')
      expect(section).not.toContain('{@html')
    })
  })
})
