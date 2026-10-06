import { PgBoss } from 'pg-boss'
import type { WorkConcurrencyOptions } from 'pg-boss'
import { pgBossConnectionOptions } from '@project-vault/db/pg-tls'
import { forEachSequential } from './for-each-sequential.js'

type BossSendOptions = {
  retryLimit?: number
  retryBackoff?: boolean
  retryDelay?: number
  // Story 5.3 AC-9: pg-boss's native singletonKey dedup — used by the stale-rotation recovery
  // job's startup-once enqueue (`boss.send('rotation/recover', {}, { singletonKey:
  // 'rotation/recover' })`) so a hot-reload/restart never queues a duplicate immediate run
  // alongside the 15-minute cron. pg-boss's send() already supports this; this thin wrapper
  // type just didn't expose it yet.
  singletonKey?: string
}

type BossClient = Pick<PgBoss, 'start' | 'stop'> &
  Partial<Pick<PgBoss, 'createQueue' | 'schedule' | 'unschedule' | 'work' | 'send'>>
type BossFactory = () => BossClient

export type BossJob = { id?: string; data?: Record<string, unknown> }

export type WorkerOptions = WorkConcurrencyOptions

export type WorkerRegistration =
  | ((job: BossJob) => Promise<void>)
  | { handler: (job: BossJob) => Promise<void>; options?: WorkerOptions }

const BOSS_NOT_STARTED_ERROR = 'BossService not started'

export class BossService {
  readonly #createBoss: BossFactory
  #boss: BossClient | null = null
  readonly #createdQueues = new Set<string>()

  constructor(connectionStringOrFactory: string | BossFactory) {
    this.#createBoss =
      typeof connectionStringOrFactory === 'string'
        ? () => new PgBoss(pgBossConnectionOptions(connectionStringOrFactory))
        : connectionStringOrFactory
  }

  isStarted(): boolean {
    return this.#boss !== null
  }

  async start(): Promise<void> {
    if (this.#boss) {
      return
    }

    const boss = this.#createBoss()
    await boss.start()
    this.#boss = boss
  }

  async stop(): Promise<void> {
    if (!this.#boss) {
      return
    }

    const boss = this.#boss
    this.#boss = null
    await boss.stop()
  }

  async ensureQueue(name: string): Promise<void> {
    if (!this.#boss) throw new Error(BOSS_NOT_STARTED_ERROR)
    if (this.#createdQueues.has(name)) return
    if (!this.#boss.createQueue) throw new Error('BossService createQueue API unavailable')
    await this.#boss.createQueue(name)
    this.#createdQueues.add(name)
  }

  async send(
    name: string,
    data: Record<string, unknown>,
    options?: BossSendOptions
  ): Promise<string | null> {
    if (!this.#boss) throw new Error(BOSS_NOT_STARTED_ERROR)
    if (!this.#boss.send) throw new Error('BossService send API unavailable')
    await this.ensureQueue(name)
    return this.#boss.send(name, data, options)
  }

  async registerSchedules(schedules: Record<string, { cron: string }>): Promise<void> {
    if (!this.#boss) throw new Error(BOSS_NOT_STARTED_ERROR)
    if (!this.#boss.schedule) throw new Error('BossService schedule API unavailable')
    const boss = this.#boss
    await forEachSequential(Object.entries(schedules), async ([name, { cron }]) => {
      await this.ensureQueue(name)
      await boss.schedule?.(name, cron, null, { tz: 'UTC' })
    })
  }

  /**
   * Story 70.1 AC3 — removes a cron schedule. pg-boss persists schedules in Postgres across
   * deploys, so deleting a key from `registerSchedules` does not stop it; it must be removed
   * explicitly. pg-boss's `unschedule` is an idempotent DELETE (a no-op when absent). A failure
   * propagates (boot fails, like a `registerSchedules` failure).
   */
  async unschedule(name: string): Promise<void> {
    if (!this.#boss) throw new Error(BOSS_NOT_STARTED_ERROR)
    if (!this.#boss.unschedule) throw new Error('BossService unschedule API unavailable')
    await this.#boss.unschedule(name)
  }

  async registerWorker(
    name: string,
    handler: (job: BossJob) => Promise<void>,
    options?: WorkerOptions
  ): Promise<void> {
    if (!this.#boss) throw new Error(BOSS_NOT_STARTED_ERROR)
    if (!this.#boss.work) throw new Error('BossService work API unavailable')
    await this.ensureQueue(name)
    // pg-boss 12 always invokes work callbacks with a batch array (Job[]), even at the default
    // batchSize of 1 — no handler here opts into multi-job batches, so unwrap to the single job
    // every registered handler actually expects. Without this, `job.data`/`job.id` reads silently
    // see `undefined` (array properties), which is indistinguishable from a malformed job at the
    // handler level — this is what caused notification/email and notification/deliver jobs to
    // fail on every attempt with "missing notificationQueueId or orgId".
    const runSingle = async (jobs: unknown) => {
      const [job] = Array.isArray(jobs) ? jobs : [jobs]
      return handler(job as BossJob)
    }
    if (options?.localConcurrency !== undefined || options?.localGroupConcurrency !== undefined) {
      await this.#boss.work(name, options, runSingle)
      return
    }
    await this.#boss.work(name, runSingle)
  }

  async registerWorkers(handlers: Record<string, WorkerRegistration>): Promise<void> {
    await forEachSequential(Object.entries(handlers), ([name, registration]) =>
      typeof registration === 'function'
        ? this.registerWorker(name, registration)
        : this.registerWorker(name, registration.handler, registration.options)
    )
  }
}

export default BossService
