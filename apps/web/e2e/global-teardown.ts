// AC-I2: optional cleanup only — the docker-compose stack itself is deliberately left running
// (dev convenience, matching this repo's own `make docker-up`/`make bootstrap-docker` workflow
// where the stack persists across multiple local iterations). Nothing to tear down today; this
// file exists so a future addition (e.g. closing a shared resource) has an obvious home.
export default async function globalTeardown(): Promise<void> {
  // Intentionally empty.
}
