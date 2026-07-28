<script lang="ts">
  import { resolve } from '$app/paths'
  import { m } from '$lib/paraglide/messages.js'
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
    <li>
      <a
        href={resolve('/settings/security')}
        class="flex items-center justify-between px-6 py-4 hover:bg-gray-50"
      >
        <div>
          <p class="font-medium text-gray-900">Security</p>
          <p class="text-sm text-gray-500">
            Multi-factor authentication enrollment and recovery codes
          </p>
        </div>
        <span class="text-gray-400">→</span>
      </a>
    </li>
    <li>
      <a
        href={resolve('/settings/language')}
        class="flex items-center justify-between px-6 py-4 hover:bg-gray-50"
      >
        <div>
          <p class="font-medium text-gray-900">{m.settings_nav_language_title()}</p>
          <p class="text-sm text-gray-500">{m.settings_nav_language_description()}</p>
        </div>
        <span class="text-gray-400">→</span>
      </a>
    </li>
    <li>
      <a
        href={resolve('/settings/themes')}
        class="flex items-center justify-between px-6 py-4 hover:bg-gray-50"
      >
        <div>
          <p class="font-medium text-gray-900">Themes</p>
          <p class="text-sm text-gray-500">Choose which installed theme is active for your view</p>
        </div>
        <span class="text-gray-400">→</span>
      </a>
    </li>
    <li>
      <a
        href={resolve('/settings/audit')}
        class="flex items-center justify-between px-6 py-4 hover:bg-gray-50"
      >
        <div>
          <p class="font-medium text-gray-900">Audit & Compliance</p>
          <p class="text-sm text-gray-500">
            Audit log search, export, access reports, and erasure requests
          </p>
        </div>
        <span class="text-gray-400">→</span>
      </a>
    </li>
    <li>
      <a
        href={resolve('/settings/extensions')}
        class="flex items-center justify-between px-6 py-4 hover:bg-gray-50"
      >
        <div>
          <p class="font-medium text-gray-900">Extensions</p>
          <p class="text-sm text-gray-500">
            Whether a configured extension is loaded, not configured, or failed to load
          </p>
        </div>
        <span class="text-gray-400">→</span>
      </a>
    </li>
    <li>
      <a
        href={resolve('/settings/sso-domains')}
        class="flex items-center justify-between px-6 py-4 hover:bg-gray-50"
      >
        <div>
          <p class="font-medium text-gray-900">SSO Domains</p>
          <p class="text-sm text-gray-500">
            Which email domains route into which SSO provider for this organization
          </p>
        </div>
        <span class="text-gray-400">→</span>
      </a>
    </li>
    <li>
      <a
        href={resolve('/settings/external-identities')}
        class="flex items-center justify-between px-6 py-4 hover:bg-gray-50"
      >
        <div>
          <p class="font-medium text-gray-900">External Identities</p>
          <p class="text-sm text-gray-500">
            Which org members have a linked identity for SSO sign-in, link a new one, or unlink a
            stale one
          </p>
        </div>
        <span class="text-gray-400">→</span>
      </a>
    </li>
  </ul>
</div>
