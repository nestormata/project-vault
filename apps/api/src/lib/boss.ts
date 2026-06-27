import { PgBoss } from 'pg-boss'

type BossClient = Pick<PgBoss, 'start' | 'stop'> & Partial<Pick<PgBoss, 'schedule' | 'work'>>
type BossFactory = () => BossClient

export class BossService {
  readonly #createBoss: BossFactory
  #boss: BossClient | null = null

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

  async registerSchedules(schedules: Record<string, { cron: string }>): Promise<void> {
    if (!this.#boss) throw new Error('BossService not started')
    if (!this.#boss.schedule) throw new Error('BossService schedule API unavailable')
    for (const [name, { cron }] of Object.entries(schedules)) {
      await this.#boss.schedule(name, cron, null, { tz: 'UTC' })
    }
  }

  async registerWorkers(handlers: Record<string, () => Promise<void>>): Promise<void> {
    if (!this.#boss) throw new Error('BossService not started')
    if (!this.#boss.work) throw new Error('BossService work API unavailable')
    for (const [name, handler] of Object.entries(handlers)) {
      await this.#boss.work(name, handler)
    }
  }
}
