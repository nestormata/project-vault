<script lang="ts">
  import { resolve } from '$app/paths'
  import { buildAbsoluteUrl } from '@project-vault/shared'
  import { ApiClientError } from '$lib/api/client.js'
  import MfaAwareErrorAlert from '$lib/components/MfaAwareErrorAlert.svelte'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'
  import type { ServiceEndpoint } from '$lib/api/service-endpoints.js'
  import {
    disableStatusPage,
    enableStatusPage,
    regenerateStatusPageToken,
    updateStatusPageServices,
  } from '$lib/api/status-page.js'

  let { data } = $props()

  let enabled = $state(data.config.enabled)
  // Ephemeral fallback for the instant right after enable/regenerate: the POST response still
  // returns the raw token directly, but `data.config` (the last GET) hasn't been re-fetched yet
  // to include it. Once the page re-loads config, `data.config.token` takes over.
  let freshToken = $state<string | null>(null)
  let configToken = $state<string | null>(data.config.token ?? null)
  let errorMessage = $state<string | null>(null)
  let isBusy = $state(false)
  let copied = $state(false)

  type SelectedService = { serviceId: string; displayName: string }
  const initialSelected = (data.config.services ?? []).map((s) => ({
    serviceId: s.serviceId,
    displayName: s.displayName,
  }))
  let selected = $state<SelectedService[]>(initialSelected)
  let persistedSelected = $state<SelectedService[]>(initialSelected)

  const activeToken = $derived(configToken ?? freshToken)
  const publicUrl = $derived(
    activeToken ? buildAbsoluteUrl(data.origin, `/status/${activeToken}`) : null
  )

  function isSelected(serviceId: string): boolean {
    return selected.some((s) => s.serviceId === serviceId)
  }

  function toggleService(service: ServiceEndpoint) {
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
      const result = await enableStatusPage(fetch, data.projectId)
      freshToken = result.token
      configToken = null
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
      const result = await regenerateStatusPageToken(fetch, data.projectId)
      freshToken = result.token
      configToken = null
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

<section class="space-y-6">
  <div class="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
    <p class="text-sm font-semibold uppercase tracking-wide text-slate-500">Project settings</p>
    <h1 class="mt-2 text-3xl font-bold text-slate-950">Public status page</h1>
    <p class="mt-2 text-slate-600">
      Share a read-only status page with stakeholders who don't have a Project Vault account. The
      services shown here are your monitored HTTP endpoints — a separate list from any billing or
      hosting "services" you've recorded elsewhere for this project.
    </p>
  </div>

  {#if !data.canManage}
    <div class="rounded-2xl border border-slate-200 bg-slate-50 p-6">
      <p class="text-slate-600">
        Only the project owner or an org owner can manage the public status page.
      </p>
    </div>
  {:else}
    <MfaAwareErrorAlert
      message={errorMessage}
      class="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800"
    />

    {#if !enabled}
      <div class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <p class="text-slate-600">No public status page has been created for this project yet.</p>
        <button
          class="mt-4 rounded-xl bg-slate-950 px-4 py-2 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
          type="button"
          disabled={isBusy}
          onclick={() => onEnable()}
        >
          Enable public status page
        </button>
      </div>
    {:else}
      <div class="space-y-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div class="flex items-center justify-between">
          <h2 class="text-xl font-semibold text-slate-950">Shareable link</h2>
          <div class="flex gap-2">
            <button
              class="rounded-xl border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-900 disabled:cursor-not-allowed disabled:opacity-60"
              type="button"
              disabled={isBusy}
              onclick={() => onRegenerate()}
            >
              Regenerate link
            </button>
            <button
              class="rounded-xl border border-red-300 px-3 py-2 text-sm font-semibold text-red-700 disabled:cursor-not-allowed disabled:opacity-60"
              type="button"
              disabled={isBusy}
              onclick={() => onDisable()}
            >
              Disable
            </button>
          </div>
        </div>

        {#if publicUrl}
          <div class="space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-4">
            <div class="flex flex-wrap items-center gap-2">
              <code class="break-all rounded-lg bg-white px-3 py-2 text-sm">{publicUrl}</code>
              <button
                class="rounded-lg bg-slate-950 px-3 py-2 text-sm font-semibold text-white"
                type="button"
                onclick={() => copyUrl()}
              >
                {copied ? 'Copied!' : 'Copy'}
              </button>
            </div>
          </div>
        {:else}
          <p class="text-sm text-slate-500">
            This link isn't persistently viewable yet — regenerate to get a persistent link.
          </p>
        {/if}
      </div>

      <div class="space-y-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 class="text-xl font-semibold text-slate-950">Services shown on the public page</h2>
        {#if selected.length > 0}
          <div class="space-y-2 rounded-xl border border-slate-100 bg-slate-50 p-4">
            <div>
              <h3 class="font-semibold text-slate-950">Public service order</h3>
              <p class="text-sm text-slate-600">
                Use the keyboard-operable move buttons to choose the order visitors see.
              </p>
            </div>
            <ol aria-label="Public service order" class="space-y-2">
              {#each selected as service, index (service.serviceId)}
                {@const label = serviceLabel(service.serviceId, service.displayName)}
                <li class="flex items-center justify-between gap-3 rounded-lg bg-white p-3">
                  <span class="min-w-0 truncate text-sm font-medium text-slate-800">{label}</span>
                  {#if selected.length > 1}
                    <span class="flex shrink-0 gap-1">
                      <button
                        class="rounded-lg border border-slate-300 px-2 py-1 text-sm text-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
                        type="button"
                        aria-label={`Move ${label} up`}
                        disabled={isBusy || index === 0}
                        onclick={() => moveService(index, -1)}
                      >
                        ↑
                      </button>
                      <button
                        class="rounded-lg border border-slate-300 px-2 py-1 text-sm text-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
                        type="button"
                        aria-label={`Move ${label} down`}
                        disabled={isBusy || index === selected.length - 1}
                        onclick={() => moveService(index, 1)}
                      >
                        ↓
                      </button>
                    </span>
                  {/if}
                </li>
              {/each}
            </ol>
          </div>
        {/if}
        {#if data.serviceEndpoints.length === 0}
          <p class="text-slate-600">
            No monitored service endpoints exist for this project yet —
            <a
              class="font-medium text-slate-950 underline"
              href={resolve(`/projects/${data.projectId}/service-endpoints`)}
            >
              register one first
            </a>
            .
          </p>
        {:else}
          <ul class="space-y-3">
            {#each data.serviceEndpoints as service (service.id)}
              {@const current = selected.find((s) => s.serviceId === service.id)}
              <li class="flex flex-wrap items-center gap-3 rounded-xl border border-slate-100 p-3">
                <label class="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={Boolean(current)}
                    onchange={() => toggleService(service)}
                    aria-describedby={`status-page-service-help-${service.id}`}
                  />
                  <span class="text-sm text-slate-600">{service.name}</span>
                </label>
                {#if current}
                  <input
                    class="min-w-0 flex-1 rounded-lg border border-slate-300 px-2 py-1 text-sm"
                    type="text"
                    placeholder="Public display name"
                    value={current.displayName}
                    aria-describedby={`status-page-display-name-help-${service.id}`}
                    oninput={(event) =>
                      setDisplayName(service.id, (event.currentTarget as HTMLInputElement).value)}
                  />
                  <FormHelpText id={`status-page-display-name-help-${service.id}`} kind="text" />
                {/if}
              </li>
              <FormHelpText id={`status-page-service-help-${service.id}`} kind="checkbox" />
            {/each}
          </ul>
        {/if}
        <button
          class="rounded-xl bg-slate-950 px-4 py-2 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
          type="button"
          disabled={isBusy}
          onclick={() => onSaveServices()}
        >
          Save services
        </button>
      </div>
    {/if}
  {/if}
</section>
