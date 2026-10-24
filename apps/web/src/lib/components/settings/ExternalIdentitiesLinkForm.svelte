<script lang="ts">
  import { invalidateAll } from '$app/navigation'
  import { linkExternalIdentity } from '$lib/api/external-identities.js'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'
  import { externalIdentityErrorMessage } from './external-identity-errors.js'

  // Story 69.11: the link-identity form of the external identities page as one replaceable region.
  // It owns the typed values, the busy flag and the link error; the member options come from the
  // page.
  let {
    orgUsers,
    data,
  }: {
    orgUsers: readonly { userId: string; email: string }[]
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()

  // AC-12 Judgment call: providerName is free-text, not a <select> — no authenticated
  // "list registered strategies" endpoint is exposed to the web app today. Same reasoning as
  // 14-6's Task 6 judgment call.
  let newUserId = $state('')
  let newProviderName = $state('')
  let newExternalSubject = $state('')
  let linkBusy = $state(false)
  let linkError = $state<string | null>(null)
  async function onLink(event: SubmitEvent) {
    event.preventDefault()
    if (linkBusy) return
    linkBusy = true
    linkError = null
    try {
      await linkExternalIdentity(fetch, {
        userId: newUserId,
        providerName: newProviderName,
        externalSubject: newExternalSubject,
      })
      newUserId = ''
      newProviderName = ''
      newExternalSubject = ''
      await invalidateAll()
    } catch (error) {
      linkError = externalIdentityErrorMessage(
        error,
        ['conflict', 'user_not_found'],
        'Failed to link identity.'
      )
    } finally {
      linkBusy = false
    }
  }
</script>

<!-- @region settings.external-identities.link -->
<form class="mt-8 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm" onsubmit={onLink}>
  <h2 class="text-lg font-semibold text-slate-950">Link identity</h2>
  <div class="mt-4 flex flex-wrap items-end gap-3">
    <label class="flex flex-col gap-1 text-sm" for="new-user">
      Member
      <select
        id="new-user"
        class="rounded-xl border border-slate-300 px-3 py-2 text-sm"
        bind:value={newUserId}
        required
        aria-describedby="external-identity-member-help"
      >
        <option value="" disabled>Choose a member…</option>
        {#each orgUsers as orgUser (orgUser.userId)}
          <option value={orgUser.userId}>{orgUser.email}</option>
        {/each}
      </select>
      <FormHelpText id="external-identity-member-help" kind="select" />
    </label>
    <label class="flex flex-col gap-1 text-sm" for="new-provider-name">
      Provider name
      <input
        id="new-provider-name"
        type="text"
        class="rounded-xl border border-slate-300 px-3 py-2 text-sm"
        placeholder="e.g. test.mock-sso-extension"
        aria-describedby="external-identity-provider-help"
        bind:value={newProviderName}
        required
      />
      <FormHelpText id="external-identity-provider-help" kind="text" />
    </label>
    <label class="flex flex-col gap-1 text-sm" for="new-external-subject">
      External subject
      <input
        id="new-external-subject"
        type="text"
        class="rounded-xl border border-slate-300 px-3 py-2 text-sm"
        placeholder="e.g. alex-sso-subject-123"
        aria-describedby="external-identity-subject-help"
        bind:value={newExternalSubject}
        required
      />
      <FormHelpText id="external-identity-subject-help" kind="text" />
    </label>
    <button
      type="submit"
      class="rounded-xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
      disabled={linkBusy || !newUserId || !newProviderName || !newExternalSubject}
    >
      {linkBusy ? 'Linking…' : 'Link identity'}
    </button>
  </div>
  {#if linkError}
    <p class="mt-2 text-sm text-red-700" role="alert">{linkError}</p>
  {/if}<InjectionPoint name="settings.external-identities.link" {data} />
</form>
