<script lang="ts">
  import NavLink from '$lib/navigation/NavLink.svelte'

  // Story 69.4: the back link, title and description of the notification settings page. The page
  // keeps the container element and renders its `settings.notifications.header` point after this.
</script>

<NavLink
  surface="back"
  node="back.settings.notifications"
  class="text-sm text-indigo-600 hover:text-indigo-800"
/>
<h1 class="mt-2 text-2xl font-bold text-gray-900">Notification Preferences</h1>
<p class="text-gray-500">Configure how and when you receive alerts from Project Vault.</p>
