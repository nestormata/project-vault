import { randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { registerAndLoginViaApi } from '../fixtures/auth.js'
import { createProjectViaApi, createServiceEndpointViaApi } from '../fixtures/api.js'
import { uniqueEmail, uniqueOrgName, uniqueProjectName } from '../fixtures/ids.js'

// Story 18.13 AC-5: the endpoint list must hold its table shape at both a desktop and a narrow
// viewport — long names/URLs scroll inside the card rather than pushing the page body sideways,
// and the actions column stays present for a manager at every width.
const VIEWPORTS = [
  { label: 'desktop', width: 1280, height: 800 },
  { label: 'narrow', width: 375, height: 667 },
] as const

const SHORT_NAME = 'Short canary'
const LONG_NAME = `Extremely long endpoint name ${'x'.repeat(160)}`
const LONG_URL = `https://example.com/${'segment/'.repeat(30)}health`

async function columnLeftEdges(row: import('@playwright/test').Locator): Promise<number[]> {
  return row
    .locator('td')
    .evaluateAll((cells) => cells.map((cell) => cell.getBoundingClientRect().x))
}

test.describe('Story 18.13 — service endpoint list layout', () => {
  test('owner sees an aligned endpoint table at desktop and narrow widths', async ({
    page,
    context,
  }) => {
    const ownerPassword = ['e2e', 'Story1813', 'Owner', 'Password', '123'].join('-')
    await registerAndLoginViaApi(context, {
      email: uniqueEmail('story1813-owner'),
      password: ownerPassword,
      orgName: uniqueOrgName('Story 18.13 Layout Org'),
    })
    const project = await createProjectViaApi(context, {
      name: uniqueProjectName('Story 18.13 Layout Project'),
      // randomUUID, not Date.now(): two workers can share a millisecond. Kept under the 50-char
      // slug limit.
      slug: `s1813-${randomUUID()}`,
    })
    await createServiceEndpointViaApi(context, project.id, {
      name: SHORT_NAME,
      url: 'https://example.com/health',
    })
    await createServiceEndpointViaApi(context, project.id, {
      name: LONG_NAME,
      url: LONG_URL,
    })

    for (const viewport of VIEWPORTS) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height })
      await page.goto(`/projects/${project.id}/service-endpoints`)

      const table = page.getByRole('table', { name: /service endpoints/i })
      await expect(table, viewport.label).toBeVisible()
      await expect(
        table.getByRole('columnheader', { name: 'Actions' }),
        viewport.label
      ).toBeVisible()
      await expect(page.getByText(SHORT_NAME), viewport.label).toBeVisible()

      const rows = table.locator('tbody tr')
      await expect(rows, viewport.label).toHaveCount(2)
      for (const row of await rows.all()) {
        await expect(row.getByRole('link', { name: 'Edit' }), viewport.label).toBeVisible()
      }

      // The long name/URL must be contained by the card's own scroll area, never by the page.
      const overflows = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth
      )
      expect(overflows, `${viewport.label} page-level horizontal overflow`).toBe(false)

      // Containment must come from a real scroll area — `overflow: hidden` would also keep the
      // page from growing, but by clipping the columns out of reach instead.
      const scrollArea = table.locator('xpath=ancestor::div[1]')
      expect(
        await scrollArea.evaluate((el) => getComputedStyle(el).overflowX),
        `${viewport.label} scroll containment`
      ).toBe('auto')

      // Every row must expose the same cells. (Comparing the two rows' cell *x* positions would
      // not: cells in one column of a single <table> share a column box and always align, so
      // such an assertion passes even with the truncation and width caps deleted.)
      const shortRow = rows.filter({ hasText: SHORT_NAME })
      const longRow = rows.filter({ hasText: LONG_NAME.slice(0, 24) })
      const shortCellXs = await columnLeftEdges(shortRow)
      const longCellXs = await columnLeftEdges(longRow)
      expect(longCellXs.length, `${viewport.label} cell count parity`).toBe(shortCellXs.length)

      // What can actually fail, and is the real subject of the story: the long name/URL are held
      // inside a bounded, truncating box rather than being allowed to size the Endpoint column.
      // Remove `max-w-*` or `truncate` from the name cell and this assertion goes red.
      const nameBox = longRow.locator('td').first().locator('div').first()
      const truncation = await nameBox.evaluate((el) => ({
        boxWidth: el.getBoundingClientRect().width,
        overflowing: Array.from(el.querySelectorAll('p')).map((p) => p.scrollWidth > p.clientWidth),
      }))
      // 20rem is the widest cap the cell declares (`sm:max-w-[20rem]`); allow a little slack for
      // sub-pixel layout rounding only.
      expect(truncation.boxWidth, `${viewport.label} endpoint cell bounded`).toBeLessThanOrEqual(
        321
      )
      // The name and the URL paragraphs are both clipped by the box rather than widening it.
      expect(
        truncation.overflowing.slice(0, 2),
        `${viewport.label} long name/URL actually truncate`
      ).toEqual([true, true])
    }
  })
})
