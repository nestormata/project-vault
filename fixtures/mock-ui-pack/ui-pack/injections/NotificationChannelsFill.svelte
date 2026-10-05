<script lang="ts">
  import { enhance } from '$app/forms'

  // Story 69.4 M3 region point: `settings.notifications.channels`, with a contribution load and a
  // contribution form action. Renders the preference count PV passes as a prop.
  let {
    data = null,
    preferences = [],
  }: {
    data?: { marker?: string; rows?: number } | null
    preferences?: readonly unknown[]
  } = $props()
</script>

<div data-testid="mock-p5-channels">
  <p data-testid="mock-p5-channels-text">
    mock-ui-pack:m3-p5-settings.notifications.channels preferences={preferences.length} rows={data?.rows ??
      'none'}
  </p>
  <form method="POST" action="?/settings.notifications.channels.save" use:enhance>
    <label for="mock-p5-channel-name">Channel name</label>
    <input id="mock-p5-channel-name" name="title" aria-describedby="mock-p5-channel-help" />
    <p id="mock-p5-channel-help">Saved through the pack's own API route.</p>
    <button type="submit">Save channel</button>
  </form>
</div>
