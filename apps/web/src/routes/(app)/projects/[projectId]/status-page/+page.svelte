<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import { buildAbsoluteUrl, CapabilityId } from '@project-vault/shared'
  import { ApiClientError } from '$lib/api/client.js'
  import StatusPageErrorRegion from '$lib/components/status-page/StatusPageErrorRegion.svelte'
  import StatusPageDisabled from '$lib/components/status-page/StatusPageDisabled.svelte'
  import StatusPageHeader from '$lib/components/status-page/StatusPageHeader.svelte'
  import StatusPageLink from '$lib/components/status-page/StatusPageLink.svelte'
  import StatusPageReadOnly from '$lib/components/status-page/StatusPageReadOnly.svelte'
  import StatusPageServices from '$lib/components/status-page/StatusPageServices.svelte'
  import type { ServiceEndpoint } from '$lib/api/service-endpoints.js'
  import type { SelectedService, ServiceRow } from '$lib/components/status-page/service-row.js'
  import {
    disableStatusPage,
    enableStatusPage,
    regenerateStatusPageToken,
    updateStatusPageServices,
  } from '$lib/api/status-page.js'

  let { data } = $props()

  // Story 23.7 AC-10: explicit `=== false`, not `!data.capabilities[...]`, so a missing/malformed
  // key defaults to "not denied" (AC-9's fail-open default), not "denied by omission".
  //
  // Both controls below are backend-enforced, not merely hidden: Story 23.3's gate on
  // POST /api/v1/projects/:projectId/status-page and this story's added gate on
  // PUT /api/v1/projects/:projectId/status-page are the actual enforcement points. Disabling
  // either button here prevents an accidental click; it does not substitute for that enforcement
  // — a direct API call from a denied org still receives 403 from both routes.
  const statusPageCapabilityDenied = $derived(
    data.capabilities?.[CapabilityId.MONITORING_PUBLIC_STATUS_PAGE] === false
  )

  // Story 68.1 AC-3: SvelteKit reuses this component across project A -> B navigation (same
  // route, new params), so everything seeded from `data.config` is a writable $derived: a new
  // load resets it, and the handlers below can still update it locally.
  let enabled = $derived(data.config.enabled)
  // Ephemeral fallback for the instant right after enable/regenerate: the POST response still
  // returns the raw token directly, but `data.config` (the last GET) hasn't been re-fetched yet
  // to include it. Once the page re-loads config, `data.config.token` takes over.
  // Story 68.1 AC-3: never derived from `data` (display-once secret), but remembered together
  // with the project it was issued for, so it can never be shown as another project's link.
  let freshToken = $state<{ projectId: string; token: string } | null>(null)
  let configToken = $derived<string | null>(data.config.token ?? null)
  // Story 6.6 AC-4: true only for a genuine legacy row (no recoverable ciphertext was ever
  // written) — never for the transient sealed-vault case, which keeps today's neutral copy.
  let legacyToken = $derived(data.config.legacyToken ?? false)
  let errorMessage = $state<string | null>(null)
  let isBusy = $state(false)
  let copied = $state(false)

  function persistedServices(): SelectedService[] {
    return (data.config.services ?? []).map((s) => ({
      serviceId: s.serviceId,
      displayName: s.displayName,
    }))
  }
  let selected = $derived<SelectedService[]>(persistedServices())
  let persistedSelected = $derived<SelectedService[]>(persistedServices())

  const activeToken = $derived(
    configToken ?? (freshToken?.projectId === data.projectId ? freshToken.token : null)
  )
  const publicUrl = $derived(
    activeToken ? buildAbsoluteUrl(data.origin, `/status/${activeToken}`) : null
  )

  function isSelected(serviceId: string): boolean {
    return selected.some((s) => s.serviceId === serviceId)
  }

  function toggleService(service: Pick<ServiceEndpoint, 'id' | 'name'>) {
    if (isSelected(service.id)) {
      selected = selected.filter((s) => s.serviceId !== service.id)
    } else {
      selected = [...selected, { serviceId: service.id, displayName: service.name }]
    }
  }

  function setDisplayName(serviceId: string, displayName: string) {
    selected = selected.map((s) => (s.serviceId === serviceId ? { ...s, displayName } : s))
  }

  function serviceLabel(serviceId: string, displayName: string): string {
    return data.serviceEndpoints.find((service) => service.id === serviceId)?.name ?? displayName
  }

  // Story 21.8: single merged row source — `selected` services first (preserving reorder-relevant
  // order), then any `data.serviceEndpoints` not currently selected, in their existing order. Feeds
  // one `<ol>` instead of the previous reorder-only box + separate checkbox list.
  const serviceRows = $derived<ServiceRow[]>([
    ...selected.map((service, index) => ({
      id: service.serviceId,
      label: serviceLabel(service.serviceId, service.displayName),
      current: service,
      index,
    })),
    ...data.serviceEndpoints
      .filter((service) => !isSelected(service.id))
      .map((service) => ({
        id: service.id,
        label: service.name,
        current: undefined,
        index: -1,
      })),
  ])

  function copyServices(services: SelectedService[]): SelectedService[] {
    return services.map((service) => ({ ...service }))
  }

  function mfaErrorMessage(error: unknown): string | null {
    if (error instanceof ApiClientError && error.code === 'mfa_required') {
      return 'Enable MFA to manage the public status page.'
    }
    return null
  }

  async function onEnable() {
    if (isBusy) return
    isBusy = true
    errorMessage = null
    try {
      const projectId = data.projectId
      const result = await enableStatusPage(fetch, projectId)
      freshToken = { projectId, token: result.token }
      configToken = null
      // Story 6.6: a fresh enable always writes a new encryptedToken, so any legacy state carried
      // over from a previously-disabled legacy row no longer applies.
      legacyToken = false
      enabled = true
      copied = false
    } catch (error) {
      errorMessage =
        mfaErrorMessage(error) ??
        (error instanceof Error ? error.message : 'Failed to enable the status page.')
    } finally {
      isBusy = false
    }
  }

  async function onRegenerate() {
    if (isBusy) return
    isBusy = true
    errorMessage = null
    try {
      const projectId = data.projectId
      const result = await regenerateStatusPageToken(fetch, projectId)
      freshToken = { projectId, token: result.token }
      configToken = null
      legacyToken = false
      copied = false
    } catch (error) {
      errorMessage =
        mfaErrorMessage(error) ??
        (error instanceof Error ? error.message : 'Failed to regenerate the token.')
    } finally {
      isBusy = false
    }
  }

  async function onDisable() {
    if (isBusy) return
    isBusy = true
    errorMessage = null
    try {
      await disableStatusPage(fetch, data.projectId)
      enabled = false
      freshToken = null
      configToken = null
      legacyToken = false
      selected = []
      persistedSelected = []
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : 'Failed to disable the status page.'
    } finally {
      isBusy = false
    }
  }

  async function onSaveServices() {
    if (isBusy) return
    isBusy = true
    errorMessage = null
    try {
      const result = await updateStatusPageServices(fetch, data.projectId, { services: selected })
      selected = result.services.map((s) => ({
        serviceId: s.serviceId,
        displayName: s.displayName,
      }))
      persistedSelected = copyServices(selected)
    } catch (error) {
      errorMessage =
        mfaErrorMessage(error) ??
        (error instanceof Error ? error.message : 'Failed to save services.')
    } finally {
      isBusy = false
    }
  }

  async function moveService(index: number, direction: -1 | 1) {
    if (isBusy || selected.length <= 1) return
    const nextIndex = index + direction
    if (nextIndex < 0 || nextIndex >= selected.length) return

    const reordered = [...selected]
    const [moved] = reordered.splice(index, 1)
    if (!moved) return
    reordered.splice(nextIndex, 0, moved)
    selected = reordered
    isBusy = true
    errorMessage = null

    try {
      const result = await updateStatusPageServices(fetch, data.projectId, { services: reordered })
      selected = result.services.map((s) => ({
        serviceId: s.serviceId,
        displayName: s.displayName,
      }))
      persistedSelected = copyServices(selected)
    } catch (error) {
      selected = copyServices(persistedSelected)
      errorMessage =
        mfaErrorMessage(error) ??
        (error instanceof Error ? error.message : 'Failed to reorder services.')
    } finally {
      isBusy = false
    }
  }

  async function copyUrl() {
    if (!publicUrl) return
    await navigator.clipboard.writeText(publicUrl)
    copied = true
  }
</script>

<svelte:head>
  <title>Public status page | Project Vault</title>
</svelte:head>

<InjectionPoint name="project.status-page.before" data={data?.__inject} />
<InjectionPoint name="project.status-page.header.actions" data={data?.__inject} />
<section class="space-y-6">
  <StatusPageHeader
    project={data.project}
    capabilities={data.capabilities}
    serviceEndpoints={data.serviceEndpoints}
    data={data.__inject}
  />

  {#if !data.canManage}
    <StatusPageReadOnly
      project={data.project}
      capabilities={data.capabilities}
      serviceEndpoints={data.serviceEndpoints}
      data={data.__inject}
    />
  {:else}
    <!-- @region project.status-page.error -->
    <StatusPageErrorRegion
      message={errorMessage}
      class="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800"
    >
      <InjectionPoint
        name="project.status-page.error"
        props={{ project: data.project }}
        data={data.__inject}
      />
    </StatusPageErrorRegion>

    {#if !enabled}
      <StatusPageDisabled
        project={data.project}
        capabilities={data.capabilities}
        serviceEndpoints={data.serviceEndpoints}
        capabilityDenied={statusPageCapabilityDenied}
        {isBusy}
        {onEnable}
        data={data.__inject}
      />
    {:else}
      <StatusPageLink
        project={data.project}
        {publicUrl}
        {legacyToken}
        {copied}
        {isBusy}
        {onRegenerate}
        {onDisable}
        onCopy={copyUrl}
        data={data.__inject}
      />

      <StatusPageServices
        project={data.project}
        capabilities={data.capabilities}
        projectId={data.projectId}
        serviceEndpoints={data.serviceEndpoints}
        rows={serviceRows}
        selectedCount={selected.length}
        capabilityDenied={statusPageCapabilityDenied}
        {isBusy}
        onToggle={toggleService}
        onSetDisplayName={setDisplayName}
        onMove={moveService}
        onSave={onSaveServices}
        data={data.__inject}
      />
    {/if}
  {/if}
</section>
<InjectionPoint name="project.status-page.after" data={data?.__inject} />
