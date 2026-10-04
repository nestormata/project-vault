<script lang="ts">
  import type { Snippet } from 'svelte'
  import {
    describeRotationCron,
    nextCronOccurrence,
    validateRotationCron,
  } from '@project-vault/shared'
  import type { CredentialDetail } from '@project-vault/shared'
  import { ApiClientError } from '$lib/api/client.js'
  import { updateCredentialLifecycle } from '$lib/api/credentials.js'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'
  import CronScheduleHelp from '$lib/components/forms/CronScheduleHelp.svelte'
  import { archivedBannerFor, credentialKeyOf } from '$lib/credentials/credential-detail-helpers.js'
  import {
    lifecycleDateInputToIso,
    toLifecycleDateInputValue,
  } from '$lib/credentials/lifecycle-form.js'
  import { m } from '$lib/paraglide/messages.js'
  import { getLocale } from '$lib/paraglide/runtime.js'
  import { resetOn } from '$lib/utils/reset-on.js'

  // Story 69.2: the Lifecycle form (expiry, rotation cron, cacheable) as one replaceable region. It
  // owns every `lifecycle*` input; a successful save is reported through `onSaved` so the header card
  // (which owns the summary override) can update the metadata tiles without a reload. `children` is
  // the region's injection point, rendered last, also when the caller cannot edit.
  let {
    credential,
    projectId,
    credentialId,
    canReveal,
    archived,
    onSaved,
    children,
  }: {
    credential: CredentialDetail
    projectId: string
    credentialId: string
    canReveal: boolean
    archived: boolean
    onSaved: (saved: { expiresAt: string | null; rotationSchedule: string | null }) => void
    children?: Snippet
  } = $props()

  // Story 68.1 AC-3: the editable lifecycle inputs re-seed when the record or its persisted value
  // changes (primitive $deriveds), but keep an in-progress edit across an unrelated reload of the
  // same credential (e.g. invalidateAll() after adding a version).
  const credentialKey = $derived(credentialKeyOf(projectId, credentialId))
  const persistedExpiresAt = $derived(credential.expiresAt ?? null)
  const persistedRotationSchedule = $derived(credential.rotationSchedule ?? '')
  // AC-L1: pre-fill from the credential detail's real cacheable flag (never hardcode `true`, which
  // would silently re-enable caching on save).
  const persistedCacheable = $derived(credential.cacheable ?? true)
  let lifecycleExpiresAt = $derived(
    resetOn(credentialKey, toLifecycleDateInputValue(persistedExpiresAt))
  )
  let lifecycleRotationSchedule = $derived(resetOn(credentialKey, persistedRotationSchedule))
  let lifecycleCacheable = $derived(resetOn(credentialKey, persistedCacheable))
  let lifecycleSubmitting = $state(false)
  let lifecycleFieldError = $state<string | null>(null)
  let lifecycleBanner = $state<string | null>(null)
  const cronLocale = getLocale() === 'es' ? 'es' : 'en'
  const lifecycleNextRun = $derived.by(() => {
    const schedule = lifecycleRotationSchedule.trim()
    if (!schedule) return null
    if (!validateRotationCron(schedule).ok) return null
    try {
      return nextCronOccurrence(schedule, new Date()).toLocaleString(undefined, {
        timeZone: 'UTC',
        timeZoneName: 'short',
      })
    } catch {
      return null
    }
  })
  const lifecycleInterpretation = $derived(
    describeRotationCron(lifecycleRotationSchedule.trim(), cronLocale)
  )

  async function onSaveLifecycle(): Promise<void> {
    if (lifecycleSubmitting) return
    lifecycleSubmitting = true
    lifecycleFieldError = null
    lifecycleBanner = null
    const requestKey = credentialKey
    try {
      const result = await updateCredentialLifecycle(fetch, projectId, credentialId, {
        expiresAt: lifecycleDateInputToIso(lifecycleExpiresAt),
        rotationSchedule:
          lifecycleRotationSchedule.trim() === '' ? null : lifecycleRotationSchedule,
        cacheable: lifecycleCacheable,
      })
      if (requestKey !== credentialKey) return
      onSaved({ expiresAt: result.expiresAt, rotationSchedule: result.rotationSchedule })
    } catch (error) {
      if (requestKey !== credentialKey) return
      const archivedBanner = archivedBannerFor(error)
      if (error instanceof ApiClientError && error.code === 'invalid_cron') {
        lifecycleFieldError = error.message
      } else if (archivedBanner) {
        lifecycleBanner = archivedBanner
      } else {
        lifecycleFieldError =
          error instanceof Error ? error.message : 'Could not update lifecycle fields.'
      }
    } finally {
      lifecycleSubmitting = false
    }
  }
</script>

{#if canReveal}
  <div class="mt-6 border-t border-slate-200 pt-6">
    <h2 class="text-lg font-semibold text-slate-950">Lifecycle</h2>
    <form
      class="mt-4 space-y-4"
      onsubmit={(event) => {
        event.preventDefault()
        void onSaveLifecycle()
      }}
    >
      <div class="space-y-1">
        <label class="block text-sm font-medium text-slate-800" for="lifecycle-expires-at">
          Expiry date
        </label>
        <input
          id="lifecycle-expires-at"
          class="w-full max-w-xs rounded-xl border border-slate-300 px-3 py-2"
          type="date"
          bind:value={lifecycleExpiresAt}
          aria-describedby="lifecycle-expires-help"
        />
        <FormHelpText id="lifecycle-expires-help" text={m.form_help_lifecycle_expiry()} />
      </div>
      <div class="space-y-1">
        <div class="flex items-center gap-2">
          <label class="block text-sm font-medium text-slate-800" for="lifecycle-rotation-schedule">
            Rotation schedule (cron)
          </label>
          <CronScheduleHelp id="lifecycle-rotation-schedule-help" />
        </div>
        <input
          id="lifecycle-rotation-schedule"
          class="w-full max-w-xs rounded-xl border border-slate-300 px-3 py-2"
          type="text"
          placeholder="0 0 1 * *"
          aria-describedby="lifecycle-rotation-schedule-help"
          bind:value={lifecycleRotationSchedule}
        />
        <FormHelpText
          id="lifecycle-rotation-schedule-help"
          text={m.form_help_rotation_schedule()}
        />
        {#if lifecycleInterpretation}
          <p class="text-sm text-slate-600">
            {m.form_help_rotation_interpretation({ description: lifecycleInterpretation })}
          </p>
        {/if}
        {#if lifecycleNextRun}
          <p class="text-sm text-slate-600">
            {m.form_help_rotation_next_run({ nextRun: lifecycleNextRun })}
          </p>
        {/if}
        <p class="text-sm text-slate-600">
          {m.form_help_lifecycle_rotation_independence()}
        </p>
        {#if lifecycleFieldError}
          <p class="text-sm text-red-700" role="alert">{lifecycleFieldError}</p>
        {/if}
      </div>
      <div class="space-y-1">
        <label class="flex items-center gap-2 text-sm text-slate-800">
          <input
            type="checkbox"
            aria-describedby="lifecycle-cacheable-help"
            bind:checked={lifecycleCacheable}
          />
          Cacheable by offline agents
        </label>
        <FormHelpText id="lifecycle-cacheable-help" text={m.form_help_cacheable()} />
      </div>
      {#if lifecycleBanner}
        <p class="text-sm text-red-700" role="alert">{lifecycleBanner}</p>
      {/if}
      <button
        class="rounded-xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
        type="submit"
        disabled={lifecycleSubmitting || archived}
      >
        {lifecycleSubmitting ? 'Saving…' : 'Save lifecycle'}
      </button>
    </form>
  </div>
{/if}{@render children?.()}
