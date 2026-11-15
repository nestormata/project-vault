<script lang="ts">
  import type { AuthUser } from '$lib/api/auth.js'
  import AppShell from './AppShell.svelte'
  import GlobalSearch from './GlobalSearch.svelte'

  let {
    user,
    open = $bindable(false),
  }: {
    user: AuthUser
    open?: boolean
  } = $props()
</script>

<GlobalSearch bind:open />
<AppShell {user} variant="rail" onsearch={() => (open = true)}>
  <p>page body</p>
</AppShell>
