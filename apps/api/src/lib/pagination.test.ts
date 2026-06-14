import { describe, it, expect } from 'vitest'
import { parsePagination, buildPaginationMeta, paginationOffset } from './pagination.js'

describe('parsePagination', () => {
  it('returns defaults for invalid input', () => {
    const result = parsePagination(undefined, undefined)
    expect(result.page).toBe(1)
    expect(result.limit).toBe(20)
  })

  it('parses valid page and limit', () => {
    const result = parsePagination('3', '50')
    expect(result.page).toBe(3)
    expect(result.limit).toBe(50)
  })

  it('clamps limit to maxLimit', () => {
    const result = parsePagination('1', '999')
    expect(result.limit).toBe(100)
  })

  it('floors non-integer page', () => {
    const result = parsePagination('2.7', '10')
    expect(result.page).toBe(2)
  })

  it('uses default page when page is less than 1', () => {
    const result = parsePagination('0', '10')
    expect(result.page).toBe(1)
  })
})

describe('buildPaginationMeta', () => {
  it('indicates hasNext when more pages exist', () => {
    const meta = buildPaginationMeta({ page: 1, limit: 10 }, 25)
    expect(meta.hasNext).toBe(true)
    expect(meta.total).toBe(25)
  })

  it('indicates no next page on last page', () => {
    const meta = buildPaginationMeta({ page: 3, limit: 10 }, 25)
    expect(meta.hasNext).toBe(false)
  })

  it('returns correct page and limit', () => {
    const meta = buildPaginationMeta({ page: 2, limit: 10 }, 30)
    expect(meta.page).toBe(2)
    expect(meta.limit).toBe(10)
  })
})

describe('paginationOffset', () => {
  it('returns 0 for page 1', () => {
    expect(paginationOffset({ page: 1, limit: 10 })).toBe(0)
  })

  it('returns correct offset for page 2', () => {
    expect(paginationOffset({ page: 2, limit: 10 })).toBe(10)
  })

  it('returns correct offset for page 3', () => {
    expect(paginationOffset({ page: 3, limit: 20 })).toBe(40)
  })
})
