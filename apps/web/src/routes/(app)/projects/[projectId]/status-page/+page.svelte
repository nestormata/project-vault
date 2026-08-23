<script lang="ts">
  import { resolve } from '$app/paths'
  import { buildAbsoluteUrl, CapabilityId } from '@project-vault/shared'
  import { ApiClientError } from '$lib/api/client.js'
  import MfaAwareErrorAlert from '$lib/components/MfaAwareErrorAlert.svelte'
  import ConfirmDeleteButton from '$lib/components/forms/ConfirmDeleteButton.svelte'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'
  import type { ServiceEndpoint } from '$lib/api/service-endpoints.js'
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
  const CAPABILITY_DENIED_HELP_ID = 'status-page-capability-denied-help'

  let enabled = $state(data.config.enabled)
  // Ephemeral fallback for the instant right after enable/regenerate: the POST response still
  // returns the raw token directly, but `data.config` (the last GET) hasn't been re-fetched yet
  // to include it. Once the page re-loads config, `data.config.token` takes over.
  let freshToken = $state<string | null>(null)
  let configToken = $state<string | null>(data.config.token ?? null)
  // Story 6.6 AC-4: true only for a genuine legacy row (no recoverable ciphertext was ever
  // written) — never for the transient sealed-vault case, which keeps today's neutral copy.
  let legacyToken = $state(data.config.legacyToken ?? false)
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

  type ServiceRow = {
    id: string
    label: string
    current: SelectedService | undefined
    index: number
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
      const result = await enableStatusPage(fetch, data.projectId)
      freshToken = result.token
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
      const result = await regenerateStatusPageToken(fetch, data.projectId)
      freshToken = result.token
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
          disabled={isBusy || statusPageCapabilityDenied}
          aria-describedby={statusPageCapabilityDenied ? CAPABILITY_DENIED_HELP_ID : undefined}
          onclick={() => onEnable()}
        >
          Enable public status page
        </button>
        {#if statusPageCapabilityDenied}
          <FormHelpText
            id={CAPABILITY_DENIED_HELP_ID}
            text="Your organization's plan doesn't include public status pages. Contact your administrator to upgrade."
          />
        {/if}
      </div>
    {:else}
      <div class="space-y-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div class="flex items-center justify-between">
          <h2 class="text-xl font-semibold text-slate-950">Shareable link</h2>
          <div class="flex gap-2">
            <!-- Story 6.6 AC-3/AC-6: two-step confirm (reused ConfirmDeleteButton pattern) so
                 rotation always requires an explicit label + a second click that warns the old
                 link stops working, instead of firing on a single click. `variant="neutral"`
                 keeps this visually distinct from the genuinely irreversible Disable button next
                 to it — regenerating a link is not the same severity as disabling the page. -->
            <ConfirmDeleteButton
              label={legacyToken ? 'Migrate to persistent link' : 'Regenerate link'}
              confirmLabel="Confirm — old link stops working?"
              pendingLabel={legacyToken ? 'Migrating…' : 'Regenerating…'}
              variant="neutral"
              disabled={isBusy}
              onConfirm={onRegenerate}
            />
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
        {:else if legacyToken}
          <!-- Story 6.6 AC-4: this URL predates persistent-link support and genuinely cannot be
               reconstructed from its stored hash — distinct, honest copy from the transient
               sealed-vault fallback below, plus the "Migrate to persistent link" action above. -->
          <p class="text-sm text-slate-500">
            This link was created before persistent links were supported, so it can't be redisplayed
            — its hash can't be reversed into the original URL. The existing shared link keeps
            working. Use "Migrate to persistent link" above for a link you can copy again later;
            doing so invalidates the current shared URL.
          </p>
        {:else}
          <p class="text-sm text-slate-500">
            This link is temporarily unavailable — try again shortly, or regenerate to get a
            persistent link.
          </p>
        {/if}
      </div>

      <div class="space-y-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 class="text-xl font-semibold text-slate-950">Services shown on the public page</h2>
        {#if serviceRows.length > 0}
          <p class="text-sm text-slate-600">
            Check a service to publish it and edit its public display name. Selected services are
            listed first, in the order they'll appear — use the keyboard-operable move buttons to
            reorder them when more than one is selected.
          </p>
          <ol aria-label="Services shown on the public page" class="space-y-3">
            {#each serviceRows as row (row.id)}
              <li class="flex flex-wrap items-center gap-3 rounded-xl border border-slate-100 p-3">
                <label class="flex min-w-[12rem] items-center gap-2">
                  <input
                    type="checkbox"
                    checked={Boolean(row.current)}
                    onchange={() => toggleService({ id: row.id, name: row.label })}
                    aria-describedby={`status-page-service-help-${row.id}`}
                  />
                  <span class="text-sm text-slate-600">{row.label}</span>
                </label>

                <div class="flex min-w-0 flex-1 items-center gap-2">
                  {#if row.current}
                    <input
                      class="min-w-0 flex-1 rounded-lg border border-slate-300 px-2 py-1 text-sm"
                      type="text"
                      placeholder="Public display name"
                      value={row.current.displayName}
                      aria-describedby={`status-page-display-name-help-${row.id}`}
                      oninput={(event) =>
                        setDisplayName(row.id, (event.currentTarget as HTMLInputElement).value)}
                    />
                    <FormHelpText id={`status-page-display-name-help-${row.id}`} kind="text" />
                  {/if}
                </div>

                <div class="flex shrink-0 items-center gap-1">
                  {#if row.current && selected.length > 1}
                    <button
                      class="rounded-lg border border-slate-300 px-2 py-1 text-sm text-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
                      type="button"
                      aria-label={`Move ${row.label} up`}
                      disabled={isBusy || row.index === 0}
                      onclick={() => moveService(row.index, -1)}
                    >
                      ↑
                    </button>
                    <button
                      class="rounded-lg border border-slate-300 px-2 py-1 text-sm text-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
                      type="button"
                      aria-label={`Move ${row.label} down`}
                      disabled={isBusy || row.index === selected.length - 1}
                      onclick={() => moveService(row.index, 1)}
                    >
                      ↓
                    </button>
                  {/if}
                </div>

                <FormHelpText id={`status-page-service-help-${row.id}`} kind="checkbox" />
              </li>
            {/each}
          </ol>
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
        {/if}
        <button
          class="rounded-xl bg-slate-950 px-4 py-2 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
          type="button"
          disabled={isBusy || statusPageCapabilityDenied}
          aria-describedby={statusPageCapabilityDenied ? CAPABILITY_DENIED_HELP_ID : undefined}
          onclick={() => onSaveServices()}
        >
          Save services
        </button>
        {#if statusPageCapabilityDenied}
          <FormHelpText
            id={CAPABILITY_DENIED_HELP_ID}
            text="Your organization's plan doesn't include public status pages. Contact your administrator to upgrade."
          />
        {/if}
      </div>
    {/if}
  {/if}
</section>
