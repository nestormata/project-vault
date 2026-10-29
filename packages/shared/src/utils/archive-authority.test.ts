import { describe, expect, it } from 'vitest'
import {
  archiveAuthority,
  projectEditAuthority,
  type ArchiveAuthority,
  type ProjectEditAuthority,
} from './archive-authority.js'

type Row = [orgRole: string | null | undefined, projectRole: string | null | undefined]

const CASES: [Row, ArchiveAuthority | null][] = [
  [['member', 'owner'], 'project_owner'],
  [['admin', 'owner'], 'project_owner'],
  [['owner', 'owner'], 'project_owner'],
  [['owner', 'member'], 'org_owner'],
  [['owner', 'viewer'], 'org_owner'],
  [['owner', undefined], 'org_owner'],
  [['admin', 'admin'], null],
  [['admin', undefined], null],
  [['admin', 'member'], null],
  [['member', 'admin'], null],
  [['member', 'member'], null],
  [['member', 'viewer'], null],
  [['member', undefined], null],
  [['viewer', 'owner'], null],
  [['viewer', 'viewer'], null],
  [[undefined, 'owner'], null],
  [[null, 'owner'], null],
  [['superuser', 'owner'], null],
]

describe('archiveAuthority', () => {
  it.each(CASES)('org %j -> %j', ([orgRole, projectRole], expected) => {
    expect(archiveAuthority(orgRole, projectRole)).toBe(expected)
  })
})

const EDIT_CASES: [Row, ProjectEditAuthority | null][] = [
  [['member', 'owner'], 'project_owner'],
  [['owner', 'member'], 'org_owner'],
  [['admin', 'owner'], 'project_owner'],
  [['admin', 'member'], 'org_admin'],
  [['admin', 'viewer'], 'org_admin'],
  [['admin', undefined], 'org_admin'],
  [['member', 'admin'], null],
  [['member', 'member'], null],
  [['member', undefined], null],
  [['viewer', 'viewer'], null],
  [['viewer', 'owner'], null],
  [[undefined, 'owner'], null],
  [['superuser', 'owner'], null],
]

describe('projectEditAuthority', () => {
  it.each(EDIT_CASES)('org %j -> %j', ([orgRole, projectRole], expected) => {
    expect(projectEditAuthority(orgRole, projectRole)).toBe(expected)
  })
})
