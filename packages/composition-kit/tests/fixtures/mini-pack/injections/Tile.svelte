<script lang="ts">
  import { enhance } from '$app/forms'
  import { goto } from '$app/navigation'

  // Story 68.4 AC-13: an injected component with server data, an injected form action and a client
  // navigation. It runs in PV's own document, router and session: nothing here is sandboxed.
  let { data = null, routeId = '' }: { data?: { healthy?: number } | null; routeId?: string } =
    $props()
</script>

<div data-testid="inject-tile" data-route={routeId}>
  <span>tile-data:{data?.healthy ?? 'none'}</span>
  <form method="POST" action="?/auth.register.after.share" use:enhance>
    <input name="note" aria-label="Note" />
    <button type="submit">Share</button>
  </form>
  <button type="button" onclick={() => goto('/login')}>Go to sign in</button>
</div>
