<script lang="ts">
  import { resolve } from '$app/paths'
  import PlatformOperatorRequiredNotice from '$lib/components/PlatformOperatorRequiredNotice.svelte'
  import PlatformWarningsBanner from '$lib/components/platform/PlatformWarningsBanner.svelte'
  import type { PageData } from './$types.js'

  let { data }: { data: PageData } = $props()

  const WARNING_MESSAGES: Record<
    string,
    { message: string; linkHref?: string; linkText?: string }
  > = {
    audit_storage_critical: {
      message:
        'Audit log storage is at critical capacity — export and prune, or increase `AUDIT_LOG_STORAGE_LIMIT_GB`.',
      linkHref: '/platform/settings/resource-usage',
      linkText: 'Resource Usage',
    },
    key_custody_risk: {
      message:
        'Master key custody risk: a single lost key file means unrecoverable data, or the key hasn\u2019t been rotated recently.',
      linkHref: '/platform/settings',
      linkText: 'System Settings',
    },
  }
</script>

<svelte:head>
  <title>Platform Admin | Project Vault</title>
</svelte:head>

{#if !data.allowed}
  <PlatformOperatorRequiredNotice />
{:else}
  <div class="mx-auto max-w-3xl px-4 py-8">
    <h1 class="text-2xl font-bold text-gray-900">Platform Admin</h1>
    <p class="mt-2 text-gray-500">Instance-wide administration and operations.</p>

    <PlatformWarningsBanner warnings={data.warnings} messages={WARNING_MESSAGES} />

    <ul class="mt-8 divide-y divide-gray-200 rounded-lg border border-gray-200 bg-white">
      <li>
        <a
          href={resolve('/platform/backups')}
          class="flex items-center justify-between px-6 py-4 hover:bg-gray-50"
        >
          <div>
            <p class="font-medium text-gray-900">Backups</p>
            <p class="text-sm text-gray-500">
              Trigger, list, validate, and restore encrypted backups
            </p>
          </div>
          <span class="text-gray-400">→</span>
        </a>
      </li>
      <li>
        <a
          href={resolve('/platform/settings')}
          class="flex items-center justify-between px-6 py-4 hover:bg-gray-50"
        >
          <div>
            <p class="font-medium text-gray-900">System Settings</p>
            <p class="text-sm text-gray-500">
              MFA policy, audit storage, organizations, and resource usage
            </p>
          </div>
          <span class="text-gray-400">→</span>
        </a>
      </li>
      <li>
        <a
          href={resolve('/platform/upgrade')}
          class="flex items-center justify-between px-6 py-4 hover:bg-gray-50"
        >
          <div>
            <p class="font-medium text-gray-900">Version & Upgrade</p>
            <p class="text-sm text-gray-500">Current version, changelog, and upgrade readiness</p>
          </div>
          <span class="text-gray-400">→</span>
        </a>
      </li>
      <li>
        <a
          href={resolve('/platform/audit')}
          class="flex items-center justify-between px-6 py-4 hover:bg-gray-50"
        >
          <div>
            <p class="font-medium text-gray-900">Platform Operator Audit Log</p>
            <p class="text-sm text-gray-500">
              Search and export instance-wide platform admin events
            </p>
          </div>
          <span class="text-gray-400">→</span>
        </a>
      </li>
    </ul>
  </div>
{/if}
