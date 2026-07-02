<script lang="ts">
  import { resolve } from '$app/paths'
</script>

<svelte:head>
  <title>Settings | Project Vault</title>
</svelte:head>

<div class="mx-auto max-w-3xl px-4 py-8">
  <h1 class="text-2xl font-bold text-gray-900">Settings</h1>
  <p class="mt-2 text-gray-500">Manage your vault preferences.</p>

  <ul class="mt-8 divide-y divide-gray-200 rounded-lg border border-gray-200 bg-white">
    <li>
      <a
        href={resolve('/settings/notifications')}
        class="flex items-center justify-between px-6 py-4 hover:bg-gray-50"
      >
        <div>
          <p class="font-medium text-gray-900">Notifications</p>
          <p class="text-sm text-gray-500">Alert delivery channels, frequency, and org routing</p>
        </div>
        <span class="text-gray-400">→</span>
      </a>
    </li>
    <li>
      <a
        href={resolve('/settings/users')}
        class="flex items-center justify-between px-6 py-4 hover:bg-gray-50"
      >
        <div>
          <p class="font-medium text-gray-900">Users</p>
          <p class="text-sm text-gray-500">Org-wide members, project roles, and account removal</p>
        </div>
        <span class="text-gray-400">→</span>
      </a>
    </li>
  </ul>
</div>
