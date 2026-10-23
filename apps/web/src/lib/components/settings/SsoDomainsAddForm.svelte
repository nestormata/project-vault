<script lang="ts">
  import { invalidateAll } from '$app/navigation'
  import { createOrgSsoDomain } from '$lib/api/org-sso-domains.js'
  import { m } from '$lib/paraglide/messages.js'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'
  import { errorMessageFor } from './sso-domain-errors.js'

  // Story 69.10: the "Add domain" form of the SSO domains page as one replaceable region. Its state
  // is used by this form only (moved verbatim from the panel).
  let {
    data,
  }: {
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()

  // AC-2: create form. Task 6 judgment call — providerName is a free-text input, not a <select>:
  // there is currently no authenticated "list registered strategies" endpoint exposed to the web
  // app (/settings/extensions's status endpoint only returns the single currently-loaded
  // extension's manifest, not a full strategies list), and building one is explicitly out of
  // scope for this story (judgment call #2) — a text input with inline server-validated
  // error display is the documented, honest fallback.
  let newDomain = $state('')
  let newProvider = $state('')
  let createBusy = $state(false)
  let createError = $state<string | null>(null)
  async function onCreate(event: SubmitEvent) {
    event.preventDefault()
    if (createBusy) return
    createBusy = true
    createError = null
    try {
      await createOrgSsoDomain(fetch, { domain: newDomain, providerName: newProvider })
      newDomain = ''
      newProvider = ''
      await invalidateAll()
    } catch (error) {
      createError = errorMessageFor(error, 'Failed to add domain.')
    } finally {
      createBusy = false
    }
  }
</script>

<!-- @region settings.sso-domains.add -->
<form class="mt-8 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm" onsubmit={onCreate}>
  <h2 class="text-lg font-semibold text-slate-950">Add domain</h2>
  <div class="mt-4 flex flex-wrap items-end gap-3">
    <label class="flex flex-col gap-1 text-sm" for="new-domain">
      Domain
      <input
        id="new-domain"
        type="text"
        class="rounded-xl border border-slate-300 px-3 py-2 text-sm"
        placeholder="acme.com"
        aria-describedby="new-domain-help"
        bind:value={newDomain}
        required
      />
    </label>
    <FormHelpText id="new-domain-help" text={m.form_help_sso_domain()} />
    <label class="flex flex-col gap-1 text-sm" for="new-provider">
      Provider name
      <input
        id="new-provider"
        type="text"
        class="rounded-xl border border-slate-300 px-3 py-2 text-sm"
        placeholder="e.g. test.mock-sso-extension"
        aria-describedby="new-provider-help"
        bind:value={newProvider}
        required
      />
    </label>
    <FormHelpText id="new-provider-help" text={m.form_help_sso_provider_name()} />
    <button
      type="submit"
      class="rounded-xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
      disabled={createBusy || !newDomain || !newProvider}
    >
      {createBusy ? 'Adding…' : 'Add domain'}
    </button>
  </div>
  <p class="mt-2 text-xs text-slate-500">
    Use a bare organization domain. Domains such as gmail.com and yahoo.com cannot be mapped.
  </p>
  {#if createError}
    <p class="mt-2 text-sm text-red-700" role="alert">{createError}</p>
  {/if}<InjectionPoint name="settings.sso-domains.add" {data} />
</form>
