import { PgBoss } from 'pg-boss'

type BossClient = Pick<PgBoss, 'start' | 'stop'>
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
}
