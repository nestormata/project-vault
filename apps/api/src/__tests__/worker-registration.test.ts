import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('credentials:prune-versions registration (AC-8 R3)', () => {
  it('is registered in both the schedules and workers maps in main.ts', () => {
    const mainSource = readFileSync(resolve(process.cwd(), 'src/main.ts'), 'utf-8')
    const schedulesBlock = mainSource.slice(
      mainSource.indexOf('registerSchedules({'),
      mainSource.indexOf('})', mainSource.indexOf('registerSchedules({'))
    )
    const workersBlock = mainSource.slice(
      mainSource.indexOf('registerWorkers({'),
      mainSource.indexOf('})', mainSource.indexOf('registerWorkers({'))
    )

    expect(schedulesBlock).toContain("'credentials:prune-versions'")
    expect(workersBlock).toContain("'credentials:prune-versions'")
  })
})
