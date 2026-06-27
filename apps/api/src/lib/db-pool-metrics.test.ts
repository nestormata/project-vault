import { describe, expect, it } from 'vitest'
import { register } from 'prom-client'
import { DB_POOL_CONNECTIONS_ACTIVE_METRIC_NAME, instrumentDbPool } from './db-pool-metrics.js'

async function currentGaugeValue(): Promise<number> {
  const metric = await register.getSingleMetricAsString(DB_POOL_CONNECTIONS_ACTIVE_METRIC_NAME)
  const match = metric.match(/^db_pool_connections_active\s+(\d+)/m)
  return Number(match?.[1] ?? Number.NaN)
}

describe('instrumentDbPool', () => {
  it('increments active DB query gauge while query is in flight and decrements after success', async () => {
    let release!: () => void
    const queryDone = new Promise<void>((resolve) => {
      release = resolve
    })
    const pool = instrumentDbPool({
      query: async (_statement: string) => {
        expect(await currentGaugeValue()).toBe(1)
        release()
        return [{ ok: true }]
      },
    })

    await expect(pool.query('SELECT 1')).resolves.toEqual([{ ok: true }])
    await queryDone
    expect(await currentGaugeValue()).toBe(0)
  })

  it('decrements active DB query gauge when query throws', async () => {
    const error = new Error('query failed')
    const pool = instrumentDbPool({
      query: async (_statement: string) => {
        expect(await currentGaugeValue()).toBe(1)
        throw error
      },
    })

    await expect(pool.query('SELECT fail')).rejects.toBe(error)
    expect(await currentGaugeValue()).toBe(0)
  })
})
