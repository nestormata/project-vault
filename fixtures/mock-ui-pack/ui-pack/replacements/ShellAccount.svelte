<script lang="ts">
  // M4: a replacement that WRAPS PV's original through `pv-original:` and adds its own region.
  import type { AuthUser } from '$lib/api/auth.js'
  import Original from 'pv-original:$lib/components/shell/ShellAccount.svelte'

  let { user }: { user: AuthUser } = $props()
</script>

<span data-testid="mock-account-wrap">mock-ui-pack:m4-account-wrap</span>
<Original {user} />
