// @pv-not-guard asserts PV's own route tree against PV's task-page rule, valid only on PV's tree
// Story 72.7 (P3b), split out by 72-22: a composed host adds (app) routes PV never classified, so this
// file is PV_TREE_ONLY_TESTS (scripts/lib/web-host/test-selection.ts) and is not shipped in web-host.
import { describe, expect, it } from 'vitest'
import { isTaskPage } from './shell-variant.js'

// The hand-kept classification of every (app) route: a new route fails this test until someone
// decides whether it is a task page (a form or flow, no bottom bar) or a browse page.
const TASK_ROUTES = [
  '/credentials/import',
  '/projects/import',
  '/projects/new',
  '/projects/x/certificates/new',
  '/projects/x/credentials/import',
  '/projects/x/credentials/new',
  '/projects/x/credentials/x/rotate',
  '/projects/x/domains/new',
  '/projects/x/machine-users/new',
  '/projects/x/service-endpoints/new',
  '/projects/x/services/new',
]

const ACTIONISH = /\/(edit|setup|create|add|transfer|enroll|invite)(\/|$)/

function appRoutes(files: readonly string[]): string[] {
  return files
    .filter((file) => file.startsWith('/src/routes/(app)/'))
    .map((file) =>
      file
        .replace('/src/routes/(app)', '')
        .replace('/+page.svelte', '')
        .replaceAll(/\[\.{0,3}[^\]]+\]/g, 'x')
    )
}

function classify(files: readonly string[]) {
  const pages = appRoutes(files)
  return {
    pages,
    tasks: pages.filter((route) => isTaskPage(route)).sort(),
    actionish: pages.filter((route) => ACTIONISH.test(route)),
  }
}

const PV_PAGES = Object.keys(import.meta.glob('/src/routes/**/+page.svelte'))

describe('the (app) route tree against the hand-kept task list', () => {
  it('classifies the real route tree against the hand-kept task list', () => {
    const { pages, tasks, actionish } = classify(PV_PAGES)
    expect(pages.length).toBeGreaterThan(30)
    expect(tasks).toEqual([...TASK_ROUTES].sort())
    // A route named like an action but not listed above is a decision someone must make.
    expect(actionish).toEqual([])
  })

  it('fails when a PV task route is added without being classified', () => {
    const added = '/src/routes/(app)/projects/[projectId]/widgets/new/+page.svelte'
    const { tasks } = classify([...PV_PAGES, added])
    expect(tasks).not.toEqual([...TASK_ROUTES].sort())
    expect(tasks).toContain('/projects/x/widgets/new')
  })

  it('fails when a classified task route stops being a task page', () => {
    const renamed = PV_PAGES.map((file) =>
      file.replace('/(app)/projects/new/+page.svelte', '/(app)/projects/create/+page.svelte')
    )
    const { tasks, actionish } = classify(renamed)
    expect(tasks).not.toContain('/projects/new')
    expect(actionish).toEqual(['/projects/create'])
  })
})
