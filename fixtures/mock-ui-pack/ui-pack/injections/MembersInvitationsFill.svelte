<script lang="ts">
  // Story 69.4 M3 region point: `project.members.invitations`, inside PV's `canManage` branch.
  // Component only; renders the invitation count PV passes as a prop.
  let { invitations = [] }: { invitations?: readonly unknown[] } = $props()
</script>

<p data-testid="mock-p5-invitations">
  mock-ui-pack:m3-p5-project.members.invitations invitations={invitations.length}
</p>
