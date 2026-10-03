<script lang="ts">
  import type { PageProps } from './$types.js'
  import HealthTile from '$cm/injections/HealthTile.svelte'
  import { formatPlan } from '$lib/cm-format.js'

  let { data }: PageProps = $props()
</script>

<h1 data-testid="billing" class="cm-brand-mark bg-[#123456] text-cm-accent">
  {formatPlan(data.plan)}
</h1>
<HealthTile />
