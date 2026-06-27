import { Gauge } from 'prom-client'

export const DB_POOL_CONNECTIONS_ACTIVE_METRIC_NAME = 'db_pool_connections_active'

export const dbPoolConnectionsActive = new Gauge({
  name: DB_POOL_CONNECTIONS_ACTIVE_METRIC_NAME,
  help: 'Number of in-flight database queries',
})

export function instrumentDbPool<T extends { query: (sql: string) => Promise<unknown> }>(
  pool: T
): T {
  return {
    ...pool,
    query: async (statement: string) => {
      dbPoolConnectionsActive.inc()
      try {
        return await pool.query(statement)
      } finally {
        dbPoolConnectionsActive.dec()
      }
    },
  } as T
}
