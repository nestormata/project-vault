export type WorkerLogger = {
  info: (payload: unknown) => void
  error: (payload: unknown) => void
}

export const defaultWorkerLogger: WorkerLogger = {
  info: (payload) => process.stdout.write(`${JSON.stringify(payload)}\n`),
  error: (payload) => process.stderr.write(`${JSON.stringify(payload)}\n`),
}

export function deletedCountFromResult(result: unknown): number {
  if (Array.isArray(result)) return result.length
  if (result && typeof result === 'object' && 'rowCount' in result) {
    return Number((result as { rowCount?: unknown }).rowCount ?? 0)
  }
  return 0
}

export async function runPruneJob(
  jobName: string,
  deleteExpiredRows: () => Promise<unknown>,
  logger: WorkerLogger = defaultWorkerLogger
): Promise<void> {
  try {
    const result = await deleteExpiredRows()
    logger.info({
      eventType: 'job.completed',
      jobName,
      deletedCount: deletedCountFromResult(result),
    })
  } catch (err) {
    logger.error({ eventType: 'job.failed', jobName, err })
    throw err
  }
}
