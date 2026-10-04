<script lang="ts">
  import { enhance } from '$app/forms'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'
  import { getEventTypeLabel } from '$lib/utils/event-type-labels.js'
  import type { RoutingItem } from '$lib/api/notifications.js'

  // Story 69.4: the body of the "Org-Level Routing" card. The page keeps the card element (inside
  // its own admin gate) and renders its `settings.notifications.routing` point after this.
  let { routing }: { routing: readonly RoutingItem[] } = $props()
</script>

<div class="border-b border-gray-200 px-6 py-4">
  <h2 class="text-lg font-semibold text-gray-800">Org-Level Routing</h2>
  <p class="mt-1 text-sm text-gray-500">
    Configure which role receives each alert type (admin only).
  </p>
</div>
<div class="px-6 py-4">
  <form method="POST" action="?/updateRouting" use:enhance>
    {#each routing as route (route.alertType)}
      <div class="mb-3 flex items-center gap-4">
        <span class="w-64 text-sm text-gray-700">
          {getEventTypeLabel(route.alertType)}
        </span>
        <select
          name="routeTo_{route.alertType}"
          class="rounded border-gray-300 text-sm"
          value={route.routeTo}
          aria-describedby="notification-route-help"
        >
          <option value="owner">Owner</option>
          <option value="admin">Admin</option>
          <option value="member">All Members</option>
        </select>
        <FormHelpText id="notification-route-help" kind="select" />
      </div>
    {/each}
    <button
      type="submit"
      class="mt-4 rounded bg-indigo-600 px-4 py-2 text-sm text-white hover:bg-indigo-700"
    >
      Save Routing
    </button>
  </form>
</div>
