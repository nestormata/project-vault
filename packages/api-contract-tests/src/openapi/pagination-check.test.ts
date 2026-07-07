import { describe, expect, it } from 'vitest'
import { checkPaginationFields, PAGINATION_EXEMPT_OPERATIONS } from './pagination-check.js'

// Story 9.3 D7/AC-11/AC-13: proves the check's sensitivity independent of any route's own
// declared response schema — using the pre-fix machine-users shape (D8.1) as the concrete
// historical example the story documents. This is a *scratch* fixture reproducing the bug's
// exact shape, not a live re-introduction of it into machine-users/schema.ts.
describe('checkPaginationFields (D7)', () => {
  it('flags a response whose data object has an array field but is missing all pagination fields (the pre-fix machine-users bug, AC-13)', () => {
    // Before this story's fix, MachineUserListResponseSchema declared only { items, total }, and
    // the actual (Zod-stripped) response also only contained { items, total } — schema
    // conformance passed trivially, yet the wire response was missing page/limit/hasNext. This
    // reproduces that exact wire-response shape.
    const preFixMachineUsersResponse = {
      data: { items: [{ id: 'a' }], total: 1 },
    }

    const missing = checkPaginationFields(preFixMachineUsersResponse)

    expect(missing).not.toBeNull()
    expect(missing).toEqual(expect.arrayContaining(['page', 'limit', 'hasNext']))
  })

  it('does not flag a response that already includes all four pagination fields (the post-fix shape)', () => {
    const postFixResponse = {
      data: { items: [], total: 0, page: 1, limit: 20, hasNext: false },
    }

    expect(checkPaginationFields(postFixResponse)).toEqual([])
  })

  it('does not apply to a response with no array-typed field under `data` (e.g. GET /auth/me, AC-11)', () => {
    const singleResourceResponse = { data: { userId: 'a', orgId: 'b' } }
    expect(checkPaginationFields(singleResourceResponse)).toBeNull()
  })

  it('does not apply to a bare top-level array under `data` (e.g. the pre-fix inbox/sessions shape) — the heuristic is scoped to an array *property* of the data object', () => {
    const bareArrayResponse = { data: [{ id: 'a' }] }
    expect(checkPaginationFields(bareArrayResponse)).toBeNull()
  })

  it('is field-name-agnostic — flags a missing pagination field regardless of the array field being named `results` instead of `items` (search)', () => {
    const searchLikeResponse = { data: { results: [{ id: 'a' }], total: 1 } }
    const missing = checkPaginationFields(searchLikeResponse)
    expect(missing).toEqual(expect.arrayContaining(['page', 'limit', 'hasNext']))
  })

  it('flags only the specific missing fields when some, but not all, pagination fields are present', () => {
    const partiallyFixed = { data: { items: [], total: 0, page: 1 } }
    expect(checkPaginationFields(partiallyFixed)).toEqual(['limit', 'hasNext'])
  })
})

// Story 9.3 code-review follow-up (edge-case review): D8 scoped its fix to 4 concrete gaps, but
// these six pre-existing, still-unpaginated operations are reachable by the same D7 blanket check
// contract.test.ts runs against every enumerated route — confirmed via direct schema inspection
// (machine-users/schema.ts's ListApiKeysResponseSchema/ActiveMachineUserKeysResponseSchema and
// monitoring/schema.ts's four list response schemas all declare only `{ items }`/`{ items, total
// }`, no page/limit/hasNext, and accept no page/limit query params server-side). Exempted rather
// than fixed here — see pagination-check.ts's doc comment for the full rationale.
describe('PAGINATION_EXEMPT_OPERATIONS (D7 follow-up)', () => {
  it('lists exactly the six confirmed pre-existing, still-unpaginated operations', () => {
    expect(PAGINATION_EXEMPT_OPERATIONS).toEqual(
      new Set([
        'GET /api/v1/machine-users/{machineUserId}/api-keys',
        'GET /api/v1/projects/{projectId}/machine-users/active-keys',
        'GET /api/v1/projects/{projectId}/services',
        'GET /api/v1/projects/{projectId}/certificates',
        'GET /api/v1/projects/{projectId}/domains',
        'GET /api/v1/projects/{projectId}/service-endpoints',
      ])
    )
  })
})
