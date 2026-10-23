<script lang="ts">
  import type { StatusTokenTestResponse } from '$lib/api/platform.js'
  import { m } from '$lib/paraglide/messages.js'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'

  // Story 69.10: the outcome of a status-token test call as one replaceable region.
  let {
    result,
    data,
  }: {
    result: StatusTokenTestResponse
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region platform.settings.status-token-test -->
<RegionFragment>
  <p
    class="mt-3 rounded-lg border px-4 py-3 text-sm"
    class:border-green-200={result.status === 'healthy'}
    class:bg-green-50={result.status === 'healthy'}
    class:text-green-800={result.status === 'healthy'}
    class:border-amber-200={result.status !== 'healthy'}
    class:bg-amber-50={result.status !== 'healthy'}
    class:text-amber-800={result.status !== 'healthy'}
    role="status"
  >
    {m.status_token_test_result_prefix()}
    <span class="font-semibold">{result.status}</span>
    {m.status_token_test_result_details({
      database: result.checks.database.status,
      vault: result.checks.vault.status,
      disk: result.checks.disk.status,
    })}<InjectionPoint name="platform.settings.status-token-test" {data} />
  </p>
</RegionFragment>
