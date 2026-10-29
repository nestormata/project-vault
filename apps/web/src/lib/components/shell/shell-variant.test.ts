// @pv-not-guard asserts PV's own route tree against PV's task-page rule, valid only on PV's tree
// Story 72.7 (P3b): the shell variant switch, the task-page rule and the text-entry rule.
import { describe, expect, it } from 'vitest'
import { isTaskPage, isTextEntry, parseShellVariant } from './shell-variant.js'

describe('parseShellVariant', () => {
  it.each([
    ['rail', 'rail'],
    [' RAIL ', 'rail'],
    ['header', 'header'],
    ['', 'header'],
    ['sidebar', 'header'],
    [undefined, 'header'],
    [null, 'header'],
  ] as const)('%j -> %s', (raw, expected) => {
    expect(parseShellVariant(raw)).toBe(expected)
  })
})

describe('isTaskPage', () => {
  it.each([
    '/projects/new',
    '/credentials/import',
    '/projects/import',
    '/projects/p1/credentials/new',
    '/projects/p1/credentials/c1/rotate',
    '/projects/p1/domains/new/',
  ])('%s is a task page', (path) => expect(isTaskPage(path)).toBe(true))

  it.each([
    '/',
    '/dashboard',
    '/projects',
    '/projects/p1',
    '/projects/p1/credentials/c1',
    '/projects/preview',
    '/projects/p1/credentials/newsletter',
    '/settings/security',
  ])('%s is not', (path) => expect(isTaskPage(path)).toBe(false))

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
  it('classifies the real route tree against the hand-kept task list', () => {
    const pages = Object.keys(import.meta.glob('/src/routes/**/+page.svelte'))
      .filter((file) => file.startsWith('/src/routes/(app)/'))
      .map((file) =>
        file
          .replace('/src/routes/(app)', '')
          .replace('/+page.svelte', '')
          .replaceAll(/\[\.{0,3}[^\]]+\]/g, 'x')
      )
    expect(pages.length).toBeGreaterThan(30)
    const tasks = pages.filter((route) => isTaskPage(route)).sort()
    expect(tasks).toEqual([...TASK_ROUTES].sort())
    // A route named like an action but not listed above is a decision someone must make.
    const actionish = pages.filter((route) =>
      /\/(edit|setup|create|add|transfer|enroll|invite)(\/|$)/.test(route)
    )
    expect(actionish).toEqual([])
  })
})

describe('isTextEntry', () => {
  const make = (html: string) => {
    const host = document.createElement('div')
    host.innerHTML = html
    return host.firstElementChild
  }
  it('is true for text-like inputs, textareas and selects', () => {
    for (const html of [
      '<input>',
      '<input type="email">',
      '<textarea></textarea>',
      '<select></select>',
    ]) {
      expect(isTextEntry(make(html)), html).toBe(true)
    }
  })
  it('is false for buttons, checkboxes, links and nothing', () => {
    for (const html of [
      '<input type="checkbox">',
      '<input type="radio">',
      '<button></button>',
      '<a href="/x">x</a>',
    ]) {
      expect(isTextEntry(make(html)), html).toBe(false)
    }
    expect(isTextEntry(null)).toBe(false)
  })
})
