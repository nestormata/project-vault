<script lang="ts">
  import { enhance } from '$app/forms'
  import { page } from '$app/state'

  // Story 69.2, M3 at the REGION point `credential.detail.actions` of PV's native credential page: a
  // control in the header card's action cluster, shown for every role (PV hides nothing, the fill
  // decides). It receives the point props (display data only: the roles are never authorization input,
  // the action below decides from server state). The action result is read through `page.form`, the
  // no-JS path as well as the enhanced one, so PV forwards nothing.
  let {
    credential = null,
    orgRole = '',
    projectRole = null,
    routeId = '',
  }: {
    credential?: { id?: string; name?: string } | null
    orgRole?: string
    projectRole?: string | null
    routeId?: string
  } = $props()

  const result = $derived(page.form as { saved?: string; error?: string } | null)
</script>

<div
  data-testid="mock-credential-actions"
  data-route={routeId}
  data-org-role={orgRole}
  data-project-role={projectRole ?? ''}
  data-credential={credential?.id ?? ''}
>
  <form method="POST" action="?/credential.detail.actions.note" use:enhance>
    <label for="mock-credential-note">Credential note</label>
    <input id="mock-credential-note" name="note" aria-describedby="mock-credential-note-help" />
    <!-- a forged role field: the action must ignore it and decide from server state -->
    <input type="hidden" name="projectRole" value="owner" />
    <span id="mock-credential-note-help">Saved through the pack's own API route.</span>
    <button type="submit">Save credential note</button>
  </form>
  <span data-testid="mock-credential-actions-result">
    {result?.saved ? `saved:${result.saved}` : result?.error ? `error:${result.error}` : 'idle'}
  </span>
</div>
