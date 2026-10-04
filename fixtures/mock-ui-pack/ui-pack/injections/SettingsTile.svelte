<script lang="ts">
  import { enhance } from '$app/forms'

  // M3: a component injected into a NATIVE PV page (settings home), with server data from a
  // contribution load and a contribution form action. It runs in PV's own document and session.
  let {
    data = null,
    routeId = '',
  }: {
    data?: { who?: string | null; probeStatus?: number | null; posted?: number | null } | null
    routeId?: string
  } = $props()
</script>

<div data-testid="mock-settings-tile" data-route={routeId}>
  <p data-testid="mock-settings-tile-user">mock-ui-pack:m3-tile user={data?.who ?? 'none'}</p>
  <p data-testid="mock-settings-tile-probe">
    mock-ui-pack:m3-probe status={data?.probeStatus ?? 'none'}
  </p>
  <form method="POST" action="?/settings.home.after.document" use:enhance>
    <label for="mock-settings-tile-title">Document title</label>
    <input id="mock-settings-tile-title" name="title" aria-describedby="mock-settings-tile-help" />
    <p id="mock-settings-tile-help">Saved through the pack's own API route.</p>
    <button type="submit">Save document</button>
  </form>
</div>
