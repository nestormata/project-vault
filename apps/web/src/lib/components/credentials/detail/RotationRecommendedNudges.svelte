<script lang="ts">
  import type { Snippet } from 'svelte'
  import { resolve } from '$app/paths'
  import { ApiClientError } from '$lib/api/client.js'
  import {
    dismissRotationRecommendedNudge,
    type RotationRecommendedBucket,
  } from '$lib/api/credential-shares.js'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'
  import { credentialKeyOf } from '$lib/credentials/credential-detail-helpers.js'
  import { resetOn } from '$lib/utils/reset-on.js'

  // Story 69.2: the rotation-recommended banners (Rotate now link, dismiss form) as one replaceable
  // region. It owns the dismiss form's state. `children` is the region's injection point, rendered
  // after the banners and whether or not any is active.
  let {
    projectId,
    credentialId,
    buckets,
    children,
  }: {
    projectId: string
    credentialId: string
    buckets: RotationRecommendedBucket[]
    children?: Snippet
  } = $props()

  // Story 68.1 AC-3: a local list, updated in place on dismiss so the badge disappears immediately;
  // a new load replaces it. The dismiss form is an in-progress edit: cleared when the record changes.
  const credentialKey = $derived(credentialKeyOf(projectId, credentialId))
  let nudgeBuckets = $derived<RotationRecommendedBucket[]>(buckets)
  let dismissingBucketKey = $derived(resetOn<string | null>(credentialKey, null))
  let dismissReason = $derived(resetOn(credentialKey, ''))
  let dismissError = $derived(resetOn<string | null>(credentialKey, null))
  const activeNudgeBuckets = $derived(nudgeBuckets.filter((bucket) => bucket.active))

  function bucketKey(fieldKey: string | null): string {
    return fieldKey ?? '__whole_credential__'
  }

  function nudgeBadgeLabel(bucket: RotationRecommendedBucket): string {
    const shareAge = bucket.mostRecentShareAt
      ? Math.max(
          0,
          Math.floor((Date.now() - new Date(bucket.mostRecentShareAt).getTime()) / 86_400_000)
        )
      : 0
    const agoText = shareAge === 1 ? '1 day ago' : `${shareAge} days ago`
    return bucket.fieldKey
      ? `Field \`${bucket.fieldKey}\` shared ${agoText} — rotation recommended`
      : `Shared ${agoText} — rotation recommended`
  }

  async function onDismissNudge(fieldKey: string | null): Promise<void> {
    if (!dismissReason.trim()) return
    dismissError = null
    const requestKey = credentialKey
    try {
      await dismissRotationRecommendedNudge(fetch, projectId, credentialId, {
        ...(fieldKey ? { fieldKey } : {}),
        reason: dismissReason,
      })
      if (requestKey !== credentialKey) return
      nudgeBuckets = nudgeBuckets.map((bucket) =>
        bucket.fieldKey === fieldKey ? { ...bucket, active: false } : bucket
      )
      dismissingBucketKey = null
      dismissReason = ''
    } catch (error) {
      if (requestKey !== credentialKey) return
      dismissError =
        error instanceof ApiClientError ? error.message : 'Failed to dismiss the nudge.'
    }
  }
</script>

<!-- Story 17.3 AC-16: a credential that has never been shared shows no badge at all — the
     badge's mere presence is itself the signal (matches this codebase's existing convention
     of omitting rather than graying out inapplicable UI). -->
{#if activeNudgeBuckets.length > 0}
  <div class="mt-4 space-y-2">
    {#each activeNudgeBuckets as bucket (bucketKey(bucket.fieldKey))}
      <div
        class="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm"
      >
        <span class="font-medium text-amber-900">{nudgeBadgeLabel(bucket)}</span>
        <div class="flex items-center gap-3">
          <a
            class="font-medium text-amber-900 underline"
            href={resolve(`/projects/${projectId}/credentials/${credentialId}/rotate`)}
          >
            Rotate now
          </a>
          {#if dismissingBucketKey === bucketKey(bucket.fieldKey)}
            <input
              type="text"
              class="rounded-lg border border-amber-300 px-2 py-1 text-xs"
              placeholder="Reason for dismissing (required)"
              bind:value={dismissReason}
              aria-describedby={`dismiss-rotation-nudge-help-${bucket.fieldKey}`}
            />
            <FormHelpText id={`dismiss-rotation-nudge-help-${bucket.fieldKey}`} kind="text" />
            <button
              type="button"
              class="text-xs font-semibold text-amber-900 underline disabled:opacity-50"
              disabled={!dismissReason.trim()}
              onclick={() => onDismissNudge(bucket.fieldKey)}
            >
              Confirm dismiss
            </button>
            <button
              type="button"
              class="text-xs text-amber-700 underline"
              onclick={() => {
                dismissingBucketKey = null
                dismissReason = ''
              }}
            >
              Cancel
            </button>
          {:else}
            <button
              type="button"
              class="text-xs font-semibold text-amber-900 underline"
              onclick={() => {
                dismissingBucketKey = bucketKey(bucket.fieldKey)
                dismissReason = ''
              }}
            >
              Dismiss
            </button>
          {/if}
        </div>
      </div>
    {/each}
    {#if dismissError}
      <p class="text-sm text-red-700">{dismissError}</p>
    {/if}
  </div>
{/if}{@render children?.()}
