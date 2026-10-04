<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import PageAlertBanner from '$lib/components/PageAlertBanner.svelte'
  import { m } from '$lib/paraglide/messages.js'

  // Story 69.1: the sealed-vault banner as one replaceable region. No point props.
  let { data }: { data?: Record<string, readonly unknown[]> | undefined } = $props()
</script>

<!-- @region dashboard.home.vault-sealed -->
<PageAlertBanner
  title={m.dashboard_vault_sealed_title()}
  message={m.dashboard_vault_sealed_message()}
>
  <InjectionPoint name="dashboard.home.vault-sealed" {data} />
</PageAlertBanner>
