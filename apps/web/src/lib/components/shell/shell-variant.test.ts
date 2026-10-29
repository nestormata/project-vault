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

  // Every route directory in the app whose last segment names a task must be a task page, and no
  // other route may be: a new `.../new` or `.../import` route is picked up (or this fails).
  it('classifies the real route tree', () => {
    const pages = Object.keys(import.meta.glob('/src/routes/**/+page.svelte')).filter((file) =>
      file.startsWith('/src/routes/(app)/')
    )
    expect(pages.length).toBeGreaterThan(30)
    for (const file of pages) {
      const route = file
        .replace('/src/routes/(app)', '')
        .replace('/+page.svelte', '')
        .replaceAll(/\[\.{0,3}[^\]]+\]/g, 'x')
      const last = route.split('/').filter(Boolean).pop()
      const expected = last === 'new' || last === 'import' || last === 'rotate'
      expect(isTaskPage(route), route).toBe(expected)
    }
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
