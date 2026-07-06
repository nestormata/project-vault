<script lang="ts">
  import { resolve } from '$app/paths'
  import { ApiClientError } from '$lib/api/client.js'
  import type { ServiceEndpoint } from '$lib/api/service-endpoints.js'
  import {
    disableStatusPage,
    enableStatusPage,
    regenerateStatusPageToken,
    updateStatusPageServices,
  } from '$lib/api/status-page.js'

  let { data } = $props()

  let enabled = $state(data.config.enabled)
  let freshToken = $state<string | null>(null)
  let errorMessage = $state<string | null>(null)
  let isBusy = $state(false)
  let copied = $state(false)

  type SelectedService = { serviceId: string; displayName: string }
  let selected = $state<SelectedService[]>(
    (data.config.services ?? []).map((s) => ({
      serviceId: s.serviceId,
      displayName: s.displayName,
    }))
  )

  const publicUrl = $derived(
    freshToken && typeof window !== 'undefined'
      ? `${window.location.origin}/status/${freshToken}`
      : null
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
      selected = []
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
    } catch (error) {
      errorMessage =
        mfaErrorMessage(error) ??
        (error instanceof Error ? error.message : 'Failed to save services.')
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
    {#if errorMessage}
      <p class="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
        {errorMessage}
      </p>
    {/if}

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
          <div class="space-y-2 rounded-xl border border-amber-200 bg-amber-50 p-4">
            <p class="text-sm font-semibold text-amber-900">
              This link cannot be shown again — copy it now, or regenerate to get a new one.
            </p>
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
            The shareable link was only shown once, when it was created or last regenerated.
            Regenerate to get a new one.
          </p>
        {/if}
      </div>

      <div class="space-y-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 class="text-xl font-semibold text-slate-950">Services shown on the public page</h2>
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
                  />
                  <span class="text-sm text-slate-600">{service.name}</span>
                </label>
                {#if current}
                  <input
                    class="min-w-0 flex-1 rounded-lg border border-slate-300 px-2 py-1 text-sm"
                    type="text"
                    placeholder="Public display name"
                    value={current.displayName}
                    oninput={(event) =>
                      setDisplayName(service.id, (event.currentTarget as HTMLInputElement).value)}
                  />
                {/if}
              </li>
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
