<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import NotificationSettingsHeader from '$lib/components/notifications/NotificationSettingsHeader.svelte'
  import NotificationPreferencesPanel from '$lib/components/notifications/NotificationPreferencesPanel.svelte'
  import NotificationRoutingPanel from '$lib/components/notifications/NotificationRoutingPanel.svelte'
  import NotificationTestPanel from '$lib/components/notifications/NotificationTestPanel.svelte'
  import type { ActionData, PageData } from './$types.js'

  const { data, form }: { data: PageData; form: ActionData } = $props()

  // Story 69.4: every region point receives the viewer's admin flags; a region's own data rides
  // along only on the point PV renders inside that region's gate.
  const flagProps = $derived({ isAdmin: data.isAdmin, canSendTest: data.canSendTest })
</script>

<svelte:head>
  <title>Notification Preferences | Project Vault</title>
</svelte:head>

<InjectionPoint name="settings.notifications.before" data={data?.__inject} />
<InjectionPoint name="settings.notifications.header.actions" data={data?.__inject} />
<div class="mx-auto max-w-4xl px-4 py-8">
  <!-- @region settings.notifications.header -->
  <div class="mb-8">
    <NotificationSettingsHeader /><InjectionPoint
      name="settings.notifications.header"
      props={flagProps}
      data={data?.__inject}
    />
  </div>

  <!-- @region settings.notifications.channels -->
  <div class="mb-8 overflow-hidden rounded-lg bg-white shadow">
    <NotificationPreferencesPanel preferences={data.preferences} /><InjectionPoint
      name="settings.notifications.channels"
      props={{ ...flagProps, preferences: data.preferences }}
      data={data?.__inject}
    />
  </div>

  {#if data.isAdmin && data.routing}
    <!-- @region settings.notifications.routing -->
    <div class="overflow-hidden rounded-lg bg-white shadow">
      <NotificationRoutingPanel routing={data.routing} /><InjectionPoint
        name="settings.notifications.routing"
        props={{ ...flagProps, routing: data.routing }}
        data={data?.__inject}
      />
    </div>
  {/if}

  {#if data.isAdmin}
    <!-- @region settings.notifications.test -->
    <div class="mt-8 overflow-hidden rounded-lg bg-white shadow">
      <div class="border-b border-gray-200 px-6 py-4">
        <h2 class="text-lg font-semibold text-gray-800">Send Test Notification</h2>
        <p class="mt-1 text-sm text-gray-500">
          Verifies SMTP/Slack delivery. Test sent to configured From address — not your personal
          inbox.
        </p>
      </div>
      <NotificationTestPanel
        canSendTest={data.canSendTest}
        testResult={form?.testResult}
        error={form?.error}
      /><InjectionPoint
        name="settings.notifications.test"
        props={flagProps}
        data={data?.__inject}
      />
    </div>
  {/if}
</div>
<InjectionPoint name="settings.notifications.after" data={data?.__inject} />
