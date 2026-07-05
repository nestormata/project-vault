import { PgBoss } from 'pg-boss'
import type { WorkConcurrencyOptions } from 'pg-boss'

type BossSendOptions = {
  retryLimit?: number
  retryBackoff?: boolean
  retryDelay?: number
  // Story 5.3 AC-9: pg-boss's native singletonKey dedup — used by the stale-rotation recovery
  // job's startup-once enqueue (`boss.send('rotation:recover', {}, { singletonKey:
  // 'rotation:recover' })`) so a hot-reload/restart never queues a duplicate immediate run
  // alongside the 15-minute cron. pg-boss's send() already supports this; this thin wrapper
  // type just didn't expose it yet.
  singletonKey?: string
}

type BossClient = Pick<PgBoss, 'start' | 'stop'> &
  Partial<Pick<PgBoss, 'createQueue' | 'schedule' | 'work' | 'send'>>
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
        ? () => new PgBoss(connectionStringOrFactory)
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
    for (const [name, { cron }] of Object.entries(schedules)) {
      await this.ensureQueue(name)
      await this.#boss.schedule(name, cron, null, { tz: 'UTC' })
    }
  }

  async registerWorker(
    name: string,
    handler: (job: BossJob) => Promise<void>,
    options?: WorkerOptions
  ): Promise<void> {
    if (!this.#boss) throw new Error(BOSS_NOT_STARTED_ERROR)
    if (!this.#boss.work) throw new Error('BossService work API unavailable')
    await this.ensureQueue(name)
    if (options?.localConcurrency !== undefined || options?.localGroupConcurrency !== undefined) {
      await this.#boss.work(name, options, async (job: unknown) => handler(job as BossJob))
      return
    }
    await this.#boss.work(name, async (job: unknown) => handler(job as BossJob))
  }

  async registerWorkers(handlers: Record<string, WorkerRegistration>): Promise<void> {
    for (const [name, registration] of Object.entries(handlers)) {
      if (typeof registration === 'function') {
        await this.registerWorker(name, registration)
        continue
      }
      await this.registerWorker(name, registration.handler, registration.options)
    }
  }
}

export default BossService
