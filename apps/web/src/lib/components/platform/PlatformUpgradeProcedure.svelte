<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'

  // Story 69.12: the "Upgrade Procedure" card of the platform upgrade page. The page drops its own
  // whitespace between this card and the next one, because the space before this point now sits
  // between the two.
  let { data }: { data?: Record<string, readonly unknown[]> | undefined } = $props()
</script>

<!-- @region platform.upgrade.procedure -->
<RegionFragment>
  <section class="mt-6 rounded-xl border border-gray-200 bg-white p-6">
    <h2 class="text-base font-semibold text-gray-900">Upgrade Procedure</h2>
    <div class="mt-3 space-y-3 text-sm text-gray-700">
      <p>
        Project Vault supports <strong>in-place upgrades</strong> via
        <code class="font-mono text-xs">docker compose up -d</code>
        with a newer image. The migration system applies only
        <strong>additive schema migrations</strong>
        automatically on startup — no destructive changes (column drops, renames, table drops) are ever
        applied automatically.
      </p>
      <p>
        If a future version requires a destructive migration, an explicit offline procedure is
        documented in the runbook. Always back up before upgrading.
      </p>
      <p>
        <a
          href="https://github.com/nestormata/project-vault/blob/main/docs/runbook.md#upgrades"
          target="_blank"
          rel="noopener noreferrer"
          class="font-medium text-indigo-600 underline"
        >
          → Upgrade procedure (docs/runbook.md § Upgrades)
        </a>
      </p>
    </div>
  </section>
  <InjectionPoint name="platform.upgrade.procedure" {data} />
</RegionFragment>
