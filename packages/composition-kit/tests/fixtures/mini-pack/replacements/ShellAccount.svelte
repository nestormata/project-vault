<script lang="ts">
  // Story 68.5 AC-12: a replacement that WRAPS PV's original through `pv-original:` and adds its own
  // header region (CentralizeMe's health indicator in the real pack).
  import type { AuthUser } from '$lib/api/auth.js'
  import Original from 'pv-original:$lib/components/shell/ShellAccount.svelte'

  let { user }: { user: AuthUser } = $props()
</script>

<span data-testid="acme-health">Acme health: ok</span>
<Original {user} />
