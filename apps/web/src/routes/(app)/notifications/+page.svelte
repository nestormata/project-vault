<script lang="ts">
  import NotificationsHeader from '$lib/components/notifications/NotificationsHeader.svelte'
  import MachineDormancyAlerts from '$lib/components/notifications/MachineDormancyAlerts.svelte'
  import UserDormancyAlerts from '$lib/components/notifications/UserDormancyAlerts.svelte'
  import NotificationsTabsRow from '$lib/components/notifications/NotificationsTabsRow.svelte'
  import NotificationsList from '$lib/components/notifications/NotificationsList.svelte'

  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'

  import type { PageData } from './$types'

  const { data }: { data: PageData } = $props()

  // Bug fix: mark-as-read/dismiss previously relied solely on `invalidateAll()` re-running the
  // server load — visible, but only after a full round trip. A writable `$derived` lets the local
  // mutations below update the row the instant the action resolves, while still recomputing from
  // `data.notifications` whenever a fresh load lands (tab switch, pagination) — the override is
  // discarded automatically the moment its source dependency changes.
  let notifications = $derived(data.notifications)

  function markReadLocally(id: string) {
    notifications = notifications.map((n) =>
      n.id === id && !n.readAt ? { ...n, readAt: new Date().toISOString() } : n
    )
  }

  function markAllReadLocallyInList() {
    notifications = notifications.map((n) =>
      n.readAt ? n : { ...n, readAt: new Date().toISOString() }
    )
  }

  function dismissLocally(id: string) {
    notifications = notifications.filter((n) => n.id !== id)
  }

  // Story 8.7 AC-H3 — reuses the same DORMANCY_MANAGE_ROLES gate as the existing machine-key
  // section (server-side load already returns [] for a non-admin/owner, but the empty-state note
  // (AC-H2) must not render at all for a role that isn't supposed to see this section in the
  // first place — an empty array alone can't distinguish "no alerts" from "wrong role").
  const canManageDormancy = $derived(data.orgRole === 'owner' || data.orgRole === 'admin')
</script>

<svelte:head>
  <title>Notifications | Project Vault</title>
</svelte:head>

<InjectionPoint name="notifications.home.before" data={data?.__inject} />
<InjectionPoint name="notifications.home.header.actions" data={data?.__inject} />
<div class="mx-auto max-w-3xl px-4 py-8">
  <!-- @region notifications.home.header -->
  <NotificationsHeader {notifications} {markAllReadLocallyInList}>
    <InjectionPoint name="notifications.home.header" data={data?.__inject} />
  </NotificationsHeader>

  <!-- @region notifications.home.machine-dormancy -->
  <MachineDormancyAlerts dormancyAlerts={data.dormancyAlerts}>
    <InjectionPoint name="notifications.home.machine-dormancy" data={data?.__inject} />
  </MachineDormancyAlerts>

  <!-- @region notifications.home.user-dormancy -->
  <UserDormancyAlerts {canManageDormancy} userDormancyAlerts={data.userDormancyAlerts}>
    <InjectionPoint name="notifications.home.user-dormancy" data={data?.__inject} />
  </UserDormancyAlerts>

  <!-- @region notifications.home.tabs -->
  <NotificationsTabsRow status={data.status}>
    <InjectionPoint name="notifications.home.tabs" data={data?.__inject} />
  </NotificationsTabsRow>

  <!-- @region notifications.home.list -->
  <NotificationsList
    {notifications}
    status={data.status}
    page={data.page}
    hasNext={data.hasNext}
    {markReadLocally}
    {dismissLocally}
  >
    <InjectionPoint name="notifications.home.list" data={data?.__inject} />
  </NotificationsList>
</div>
<InjectionPoint name="notifications.home.after" data={data?.__inject} />
