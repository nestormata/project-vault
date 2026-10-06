<script lang="ts">
  import { enhance } from '$app/forms'

  // Story 69.4 M3 region point: `project.members.access`, inside PV's `canManageMembers` gate. It
  // renders the member count PV passes as a prop and the status its load got from the real API.
  let {
    data = null,
    members = [],
  }: {
    data?: { marker?: string; projectStatus?: number; runs?: number } | null
    members?: readonly unknown[]
  } = $props()
</script>

<div data-testid="mock-p5-access">
  <p data-testid="mock-p5-access-text">
    mock-ui-pack:m3-p5-project.members.access members={members.length} status={data?.projectStatus ??
      'none'} runs={data?.runs ?? 'none'}
  </p>
  <form method="POST" action="?/project.members.access.touch" use:enhance>
    <button type="submit">Touch access</button>
  </form>
</div>
