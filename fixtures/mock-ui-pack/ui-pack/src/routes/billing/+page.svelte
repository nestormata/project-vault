<script lang="ts">
  import type { PageProps } from './$types.js'

  let { data }: PageProps = $props()
</script>

<h1 data-testid="mock-billing" class="mock-ui-pack-m6-own font-body bg-[#6b4423] text-white">
  mock-ui-pack:m2-billing
</h1>
<p data-testid="mock-billing-plan">{data.plan}</p>
<p data-testid="mock-billing-token" style="color: var(--color-primary-600)">
  mock-ui-pack:m6-token
</p>
