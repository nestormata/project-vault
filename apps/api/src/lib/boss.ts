import { PgBoss } from 'pg-boss'

type BossClient = Pick<PgBoss, 'start' | 'stop'> &
  Partial<Pick<PgBoss, 'createQueue' | 'schedule' | 'work'>>
type BossFactory = () => BossClient
export type BossJob = { id?: string }

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

  async registerSchedules(schedules: Record<string, { cron: string }>): Promise<void> {
    if (!this.#boss) throw new Error(BOSS_NOT_STARTED_ERROR)
    if (!this.#boss.schedule) throw new Error('BossService schedule API unavailable')
    for (const [name, { cron }] of Object.entries(schedules)) {
      await this.ensureQueue(name)
      await this.#boss.schedule(name, cron, null, { tz: 'UTC' })
    }
  }

  async registerWorkers(handlers: Record<string, (job: BossJob) => Promise<void>>): Promise<void> {
    if (!this.#boss) throw new Error(BOSS_NOT_STARTED_ERROR)
    if (!this.#boss.work) throw new Error('BossService work API unavailable')
    for (const [name, handler] of Object.entries(handlers)) {
      await this.ensureQueue(name)
      await this.#boss.work(name, async (job: unknown) => handler(job as BossJob))
    }
  }
}
