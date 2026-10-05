<script lang="ts">
  import { enhance } from '$app/forms'
  import { invalidateAll } from '$app/navigation'
  import { page } from '$app/state'

  // Story 69.2, M3 at the REGION point `credential.detail.shares`, rendered at the end of PV's native
  // Shares section. Its server data comes from a load PV runs through the host route's behavior table
  // because the pack opted in with `hostRoutes`; the load returns ids, a status and a per-load nonce
  // only (it is serialized into the page and `__data.json`), never a secret.
  let {
    data = null,
    credential = null,
  }: {
    data?: {
      projectId?: string | null
      credentialId?: string | null
      apiStatus?: number | null
      nonce?: string | null
    } | null
    credential?: { id?: string } | null
  } = $props()

  // SvelteKit re-runs the page load after a SUCCESSFUL enhanced action only; after a failure (a denied
  // or rate-limited action) `use:enhance` applies the result and leaves the loads alone. A fill that
  // needs fresh data after a failure (CM 16-10) asks for it. The no-JS path always re-renders the page.
  const refreshAfterFailure =
    () =>
    async ({ result, update }: { result: { type: string }; update: () => Promise<void> }) => {
      await update()
      if (result.type === 'failure') await invalidateAll()
    }

  const result = $derived(page.form as { ok?: boolean; error?: string } | null)
</script>

<div data-testid="mock-credential-shares" data-credential={credential?.id ?? ''}>
  <span data-testid="mock-credential-shares-load">
    mock-ui-pack:m3-credential-load credential={data?.credentialId ?? 'none'} status={data?.apiStatus ??
      'none'}
  </span>
  <span data-testid="mock-credential-shares-nonce">{data?.nonce ?? 'none'}</span>
  <form method="POST" action="?/credential.detail.shares.probe" use:enhance={refreshAfterFailure}>
    <button type="submit">Probe pack route</button>
  </form>
  <span data-testid="mock-credential-shares-result">
    {result?.ok ? 'ok' : result?.error ? `error:${result.error}` : 'idle'}
  </span>
</div>
