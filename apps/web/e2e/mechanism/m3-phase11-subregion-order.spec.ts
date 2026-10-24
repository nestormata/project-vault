import { randomBytes, randomUUID } from 'node:crypto'
import { expect, test, type BrowserContext } from '@playwright/test'
import { enrollMfaViaApi } from '../fixtures/auth.js'
import { setPlatformOperatorViaDb } from '../fixtures/db.js'
import {
  createCredential,
  createProject,
  open,
  precedes,
  seedCredentialPage,
  seedOrgOwner,
  trackHydrationMismatch,
} from './fixtures.js'

// Story 69-14 AC-4 / 69-6 AC-8 case 12 (probe order): the pack fills sub-region points that the eight
// remaining batch-1 region components gained when they were split. Each fill must land BETWEEN the
// two PV sections it targets (DOM order), not at the end of the region. Render-only fills. The recovery page has no case here: the pack removes
// `/(auth)/recovery/[token]` for its M1 route-removal case, so its points are covered by the
// `RecoveryResetContent.regions.test.ts` unit tests and the Chrome pass.
const SENTINEL = 'mock-ui-pack:m3-p11-'
/** Runs `body` as a platform operator (MFA enrolled, as the usage and backups pages require) and
 * hands the operator role back to whoever held it. */
async function asPlatformOperator(
  context: BrowserContext,
  label: string,
  body: () => Promise<void>
): Promise<void> {
  const operator = await seedOrgOwner(context, label)
  await enrollMfaViaApi(context)
  const displaced = await setPlatformOperatorViaDb(operator.email, true)
  try {
    await body()
  } finally {
    await setPlatformOperatorViaDb(operator.email, false)
    if (displaced !== null) await setPlatformOperatorViaDb(displaced, true)
  }
}

const id = (point: string) => `mock-p11-${point.replaceAll('.', '-')}`

test.describe('M3 sub-region points of the remaining batch-1 region components', () => {
  test('works: platform resource usage fills sit inside their cards', async ({ page, context }) => {
    const mismatches = trackHydrationMismatch(page)
    await asPlatformOperator(context, 'p11-usage', async () => {
      const users = 'platform.settings-resource-usage.users'
      const orgTable = 'platform.settings-resource-usage.org-table'
      await open(page, '/platform/settings/resource-usage', page.getByTestId(id(users)))
      await expect(page.getByTestId(id(users))).toContainText(`${SENTINEL}${users}`)
      expect(
        await precedes(
          page.getByRole('heading', { name: 'Users per Organization' }),
          page.getByTestId(id(users))
        )
      ).toBe(true)
      expect(
        await precedes(
          page.getByTestId(id(users)),
          page.getByRole('heading', { name: 'Audit Log Entries' })
        )
      ).toBe(true)
      const table = page.getByTestId(id(orgTable))
      await expect(table).toContainText(`${SENTINEL}${orgTable}`)
      expect(
        await precedes(page.getByRole('heading', { name: 'Audit Storage by Organization' }), table)
      ).toBe(true)
      expect(await precedes(page.getByRole('table'), table)).toBe(true)
      expect(mismatches()).toEqual([])
    })
  })

  test('works: platform backups fills sit after the trigger control and after the list', async ({
    page,
    context,
  }) => {
    const mismatches = trackHydrationMismatch(page)
    await asPlatformOperator(context, 'p11-backups', async () => {
      const intro = 'platform.backups.intro'
      const list = 'platform.backups.list'
      await open(page, '/platform/backups', page.getByTestId(id(intro)))
      await expect(page.getByTestId(id(intro))).toContainText(`${SENTINEL}${intro}`)
      expect(
        await precedes(
          page.getByRole('button', { name: 'Trigger backup now' }),
          page.getByTestId(id(intro))
        )
      ).toBe(true)
      expect(await precedes(page.getByTestId(id(intro)), page.getByTestId(id(list)))).toBe(true)
      expect(mismatches()).toEqual([])
    })
  })

  test('works: credential detail value and dependencies fills keep their section order', async ({
    page,
    context,
  }) => {
    const mismatches = trackHydrationMismatch(page)
    const seeded = await seedCredentialPage(context, 'p11-detail')
    const value = 'credential.detail.value-single'
    const deps = 'credential.detail.dependencies-list'
    await open(
      page,
      `/projects/${seeded.projectId}/credentials/${seeded.credentialId}`,
      page.getByTestId(id(value))
    )
    await expect(page.getByTestId(id(value))).toContainText(`${SENTINEL}${value}`)
    await expect(page.getByTestId(id(deps))).toContainText(`${SENTINEL}${deps}`)
    expect(await precedes(page.getByTestId(id(value)), page.getByTestId(id(deps)))).toBe(true)
    expect(mismatches()).toEqual([])
  })

  test('works: rotate form fills sit between the value field and the actions', async ({
    page,
    context,
  }) => {
    const mismatches = trackHydrationMismatch(page)
    const seeded = await seedCredentialPage(context, 'p11-rotate')
    const value = 'project.credentials-rotate.value'
    const actions = 'project.credentials-rotate.actions'
    await open(
      page,
      `/projects/${seeded.projectId}/credentials/${seeded.credentialId}/rotate`,
      page.getByTestId(id(value))
    )
    await expect(page.getByTestId(id(value))).toContainText(`${SENTINEL}${value}`)
    expect(
      await precedes(
        page.getByRole('textbox', { name: /new value/i }).first(),
        page.getByTestId(id(value))
      )
    ).toBe(true)
    expect(await precedes(page.getByTestId(id(value)), page.getByTestId(id(actions)))).toBe(true)
    expect(
      await precedes(
        page.getByTestId(id(actions)),
        page.getByRole('button', { name: /start rotation/i })
      )
    ).toBe(false)
    expect(mismatches()).toEqual([])
  })

  test('works: rotation detail fills sit between the summary and the checklist', async ({
    page,
    context,
  }) => {
    const mismatches = trackHydrationMismatch(page)
    const seeded = await seedCredentialPage(context, 'p11-rotation')
    const started = await context.request.post(
      `/api/v1/projects/${seeded.projectId}/credentials/${seeded.credentialId}/rotations`,
      { data: { newValue: randomBytes(18).toString('base64url') } }
    )
    expect(started.ok(), await started.text()).toBeTruthy()
    const rotationId = ((await started.json()) as { data: { id: string } }).data.id
    const summary = 'project.credentials-rotations-detail.summary'
    const checklist = 'project.credentials-rotations-detail.checklist'
    await open(
      page,
      `/projects/${seeded.projectId}/credentials/${seeded.credentialId}/rotations/${rotationId}`,
      page.getByTestId(id(summary))
    )
    await expect(page.getByTestId(id(summary))).toContainText(`${SENTINEL}${summary}`)
    expect(
      await precedes(
        page.getByRole('heading', { name: 'Rotation', exact: true }),
        page.getByTestId(id(summary))
      )
    ).toBe(true)
    expect(await precedes(page.getByTestId(id(summary)), page.getByTestId(id(checklist)))).toBe(
      true
    )
    expect(
      await precedes(
        page.getByRole('heading', { name: 'Checklist' }),
        page.getByTestId(id(checklist))
      )
    ).toBe(true)
    expect(mismatches()).toEqual([])
  })

  test('works: machine user detail fills sit between the summary and the keys', async ({
    page,
    context,
  }) => {
    const mismatches = trackHydrationMismatch(page)
    await seedOrgOwner(context, 'p11-machine')
    const projectId = await createProject(context, `p11-machine-${randomUUID().slice(0, 8)}`)
    await createCredential(context, projectId, `p11-${randomUUID().slice(0, 8)}`)
    const created = await context.request.post(`/api/v1/projects/${projectId}/machine-users`, {
      data: { name: `p11-bot-${randomUUID().slice(0, 8)}`, role: 'member' },
    })
    expect(created.ok(), await created.text()).toBeTruthy()
    const machineUserId = ((await created.json()) as { data: { id: string } }).data.id
    const summary = 'project.machine-users-detail.summary'
    const keys = 'project.machine-users-detail.keys'
    await open(
      page,
      `/projects/${projectId}/machine-users/${machineUserId}`,
      page.getByTestId(id(summary))
    )
    await expect(page.getByTestId(id(summary))).toContainText(`${SENTINEL}${summary}`)
    await expect(page.getByTestId(id(keys))).toContainText(`${SENTINEL}${keys}`)
    expect(await precedes(page.getByTestId(id(summary)), page.getByTestId(id(keys)))).toBe(true)
    expect(mismatches()).toEqual([])
  })
})
