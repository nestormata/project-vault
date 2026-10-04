// @pv-not-guard oracle of PV's own un-composed markup, valid only on PV's tree
import { cleanup, render } from '@testing-library/svelte'
import type { ComponentProps } from 'svelte'
import { afterEach, describe, expect, it } from 'vitest'
import { serializeWithoutNoise } from '$lib/test/dom.js'
import PublicStatusPage from './+page.svelte'

// Story 69.3 AC-2: characterization oracle for the public status page's region extraction. It lives
// next to its route (a composition may remove `/status`, and then it goes with it). The snapshot was
// generated from unmodified `main` BEFORE any region edit (as part of the monitoring oracle's first
// commit) and is never regenerated. Normalization matches `monitoring-extraction-oracle.test`.
afterEach(cleanup)

// The snapshot carries localized times: pin the zone so it does not depend on the test machine.
process.env.TZ = 'UTC'
const NOON = '2026-07-01T12:00:00.000Z'
const LATER = '2026-07-15T12:00:00.000Z'

type PublicData = ComponentProps<typeof PublicStatusPage>['data']

function renderPage(data: unknown): string {
  const { container } = render(PublicStatusPage, { props: { data: data as PublicData } })
  const html = serializeWithoutNoise(container).replace(/\s+/g, ' ').trim()
  cleanup()
  return html
}

const page = (services: unknown[]) => ({ statusPage: { services } })

describe('public status page extraction oracle (Story 69.3 AC-2)', () => {
  it('renders the public status page exactly as before the extraction', async () => {
    const result = {
      'public valid with services': renderPage(
        page([
          { displayName: 'API', status: 'healthy', lastCheckedAt: NOON },
          { displayName: 'Database', status: 'degraded', lastCheckedAt: LATER },
          { displayName: 'Worker', status: 'down', lastCheckedAt: NOON },
          { displayName: 'Never checked', status: 'healthy', lastCheckedAt: null },
        ])
      ),
      'public valid with no services': renderPage(page([])),
      'public invalid token': renderPage({ statusPage: null }),
    }
    await expect(`${JSON.stringify(result, null, 2)}\n`).toMatchFileSnapshot(
      './public-status-extraction.snapshot.json'
    )
    expect(Object.keys(result)).toHaveLength(3)
  })
})
