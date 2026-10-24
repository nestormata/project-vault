<script lang="ts">
  import type { CliVersionPolicyResult } from '$lib/api/platform.js'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import RegionFragment from '$lib/components/composition/RegionFragment.svelte'
  import CliVersionPolicySection from '$lib/components/platform/CliVersionPolicySection.svelte'

  // Story 69.12: the effective CLI version policy card of the platform upgrade page, with its own
  // point after the card.
  let {
    cliPolicy,
    data,
  }: {
    cliPolicy: CliVersionPolicyResult
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- Story 43.7: the effective CLI version policy pvault clients are told. -->
<!-- @region platform.upgrade.cli-policy -->
<RegionFragment>
  <CliVersionPolicySection result={cliPolicy} /><InjectionPoint
    name="platform.upgrade.cli-policy"
    {data}
  />
</RegionFragment>
