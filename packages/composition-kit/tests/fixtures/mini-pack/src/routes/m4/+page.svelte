<script lang="ts">
  // PV's own AppShell renders PV's header; its `./ShellAccount.svelte` and `./Footer.svelte` imports
  // resolve to CM's replacements (Story 68.5 AC-12).
  import AppShell from '$lib/components/shell/AppShell.svelte'
  import type { PageProps } from './$types.js'

  let { data }: PageProps = $props()
</script>

<AppShell user={data.user} hidePrimaryNav>
  <p data-testid="m4-download">{data.download}</p>
</AppShell>
