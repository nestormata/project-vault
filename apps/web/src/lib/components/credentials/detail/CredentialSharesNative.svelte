<script lang="ts">
  import { resolve } from '$app/paths'
  import type { CredentialDetail, FieldMeta } from '@project-vault/shared'
  import { buildAbsoluteUrl } from '@project-vault/shared'
  import {
    createCredentialShare,
    createExternalCredentialShare,
    revokeCredentialShare,
    type CredentialShareStatus,
    type CredentialShareSummary,
  } from '$lib/api/credential-shares.js'
  import type { OrgUser } from '$lib/api/org-users.js'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'
  import {
    archivedBannerFor,
    credentialKeyOf,
    fieldMetaOf,
    isCredentialArchived,
    type CredentialPointExtras,
  } from '$lib/credentials/credential-detail-helpers.js'
  import { formatDateTime } from '$lib/components/rotations/rotation-copy.js'
  import { resetOn, withItem } from '$lib/utils/reset-on.js'

  // Story 69.2: the native sharer UI (create with step-up, one-time link, status filter, list,
  // pagination), the inner body of the Shares region. A pack that wants to replace PV's native
  // sharer UI replaces this component (M4) and keeps its own fill at `credential.detail.shares`,
  // which lives in the outer region. The one-time share token, the step-up password and the TOTP
  // code live in this component's local state only: never a prop of any point, never in `data`.
  let {
    credential,
    projectId,
    credentialId,
    orgRole,
    origin,
    shares,
    sharesTotal,
    sharesPage,
    sharesStatus,
    orgMembers,
  }: {
    credential: CredentialDetail
    projectId: string
    credentialId: string
    orgRole: CredentialPointExtras['orgRole']
    origin: string
    shares?: CredentialShareSummary[]
    sharesTotal?: number
    sharesPage?: number
    sharesStatus?: string | null
    orgMembers?: OrgUser[]
  } = $props()

  // Story 68.1 AC-3: display-once secrets and in-progress forms are cleared when the record changes
  // (never sourced from props), and a request started on A that settles after A -> B is dropped.
  const credentialKey = $derived(credentialKeyOf(projectId, credentialId))
  function isCurrentCredential(requestKey: string): boolean {
    return requestKey === credentialKey
  }

  const isArchived = $derived(isCredentialArchived(credential))
  const fieldMeta = $derived<FieldMeta[]>(fieldMetaOf(credential))

  // Story 17.1 AC-11: local list, same writable-$derived pattern the dependency section above
  // uses — updated in place on create/revoke so the Shares tab reflects a mutation immediately
  // without a full reload.
  let shareItems = $derived<CredentialShareSummary[]>(shares ?? [])
  // Story 28.7 AC1/AC2: a real local counter, seeded from the SSR-load `sharesTotal`, kept
  // in sync by onCreateShare/onRevokeShare alongside `shareItems` above — replaces rendering
  // `sharesTotal ?? shareItems.length` directly, whose `??` fallback never fires for a
  // legitimate `0` (the exact "Showing 1 of 0" bug this fixes).
  let sharesTotalCount = $derived(sharesTotal ?? (shares ?? []).length)
  // Story 17.2 AC-21: recipient-type toggle — swaps the org-member typeahead for a plain email
  // input, and surfaces the tighter 1h default/72h cap plus the step-up prompt when 'external'.
  let shareRecipientType = $state<'user' | 'external'>('user')
  let shareRecipientUserId = $state('')
  let shareRecipientEmail = $state('')
  // Story 20.5 AC-9: attribute-key selection for the create-share form. Only explicit deviations
  // from the default ("all non-sensitive fields included, all sensitive fields excluded") are
  // stored here — the effective checked state for a given field is computed by
  // `isShareAttributeChecked` below, so this map never needs to be rebuilt when the field set
  // changes (e.g. after an in-place field-set edit re-fetches `credential`). Shared by both
  // the member and external create forms (same UI, same state) since AC-9 does not distinguish.
  let shareAttributeOverrides = $state<Record<string, boolean>>({})
  let shareExpiresInHours = $state(24)
  let shareSingleUse = $state(true)
  // Story 17.2 AC-3: step-up re-authentication, required before an external share can be
  // created. Cleared after every attempt — never retained beyond the single submit.
  let shareStepUpPassword = $derived(resetOn(credentialKey, ''))
  let shareStepUpTotp = $derived(resetOn(credentialKey, ''))
  let shareSubmitting = $state(false)
  let shareError = $state<string | null>(null)
  // Story 17.1 AC-11: the raw token is shown exactly once, right after creation (copy-once
  // affordance) — never persisted, never re-fetchable once this local state is cleared/replaced.
  // Story 68.1 AC-3: cleared when the record changes (never sourced from `data`).
  let lastCreatedShareToken = $derived(resetOn<string | null>(credentialKey, null))
  let lastCreatedShareIsExternal = $derived(resetOn(credentialKey, false))
  let revokingShareId = $state<string | null>(null)

  // Story 17.3 AC-11/AC-16: local list, same convention as `shareItems` above — updated in place

  // Story 20.5 AC-9: human-readable scope label for a share-list row — `attributeKeys` is the
  // current, generalized shape; `fieldKey` is what pre-Story-20.5 rows still carry (a share never
  // has both populated). Neither populated means whole-resource (sensitivity-default-exclusion
  // applied at creation time).
  function shareScopeLabel(share: CredentialShareSummary): string {
    if (share.attributeKeys && share.attributeKeys.length > 0) {
      return share.attributeKeys.join(', ')
    }
    if (share.fieldKey) return share.fieldKey
    return 'All non-sensitive fields'
  }

  // Story 17.3 AC-2: builds the Shares-tab pagination query string — appended onto a resolve()
  // call inline at each href (same "resolve() a literal route path with the query string
  // appended" convention the rotations "Show more" link above uses; the eslint
  // svelte/no-navigation-without-resolve rule requires the resolve() call to appear directly in
  // the href expression, not behind a helper function).
  function sharesPageQuery(targetPage: number): string {
    const params = new URLSearchParams()
    if (sharesStatus) params.set('sharesStatus', sharesStatus)
    params.set('sharesPage', String(targetPage))
    return params.toString()
  }

  // Story 28.7 AC3: whether a share with the given status belongs in the currently-visible
  // (optionally filtered) Shares-tab list — no active filter means everything matches.
  function matchesActiveSharesFilter(status: CredentialShareStatus): boolean {
    return !sharesStatus || status === sharesStatus
  }

  // Story 68.1 AC-3: a refresh that landed while the create request was in flight may already
  // list the new share (and count it in the total), so only add and count it once.
  function addShareLocally(summary: CredentialShareSummary): void {
    if (shareItems.some((item) => item.id === summary.id)) return
    shareItems = withItem(shareItems, summary, 'start')
    sharesTotalCount += 1
  }

  const EXTERNAL_SHARE_DEFAULT_HOURS = 1
  const EXTERNAL_SHARE_MAX_HOURS = 72
  const MEMBER_SHARE_MAX_HOURS = 168
  // Mirrors the backend's `AttributeKeysSchema.max(50)` (apps/api/src/modules/credential-shares/
  // schema.ts) — a client-side equivalent so a sharer who checks more than 50 boxes on a
  // many-field credential gets a specific, actionable message here rather than a generic
  // "Could not create share" after a round-trip 422.
  const SHARE_ATTRIBUTE_KEYS_MAX = 50

  const shareableOrgMembers = $derived(orgMembers ?? [])

  // Story 20.5 AC-9: a field's effective checked state in the create-share attribute picker — the
  // explicit override if the user toggled it away from default, otherwise the default itself
  // (non-sensitive => included, sensitive => excluded). Reused by both the checkbox rendering and
  // `resolveShareAttributeKeys` below so the two can never disagree on what "checked" means.
  function isShareAttributeChecked(field: FieldMeta): boolean {
    // Bugfix (review patch): `Object.hasOwn` instead of the `in` operator — `in` also matches
    // inherited `Object.prototype` properties, so a field literally named `constructor`/
    // `toString`/`hasOwnProperty`/etc. would get a false-positive "overridden" state via
    // prototype inheritance rather than falling through to the sensitivity-based default.
    if (!Object.hasOwn(effectiveShareAttributeOverrides, field.key)) return !field.sensitive
    return effectiveShareAttributeOverrides[field.key] ?? !field.sensitive
  }

  function toggleShareAttribute(field: FieldMeta): void {
    shareAttributeOverrides = {
      ...shareAttributeOverrides,
      [field.key]: !isShareAttributeChecked(field),
    }
  }

  // Story 20.5 AC-9: `null` when the current selection exactly matches the default (all
  // non-sensitive fields checked, all sensitive fields unchecked) — the more faithful mapping to
  // the backend's `attributeKeys: null` "whole-resource, sensitivity-default-exclusion applies"
  // semantics — otherwise the explicit list of checked keys.
  function resolveShareAttributeKeys(): string[] | null {
    const isDefaultSelection = fieldMeta.every(
      (field) => isShareAttributeChecked(field) === !field.sensitive
    )
    if (isDefaultSelection) return null
    return fieldMeta.filter((field) => isShareAttributeChecked(field)).map((field) => field.key)
  }

  // Story 17.2 AC-21: switching recipient type resets the expiry field to that type's own
  // reasoned default (1h external / 24h member) rather than carrying over a value that may now
  // exceed the newly-selected type's cap (72h external / 168h member).
  function onRecipientTypeChange(type: 'user' | 'external'): void {
    shareRecipientType = type
    shareExpiresInHours = type === 'external' ? EXTERNAL_SHARE_DEFAULT_HOURS : 24
    shareStepUpPassword = ''
    shareStepUpTotp = ''
  }

  async function onCreateShare(): Promise<void> {
    if (shareSubmitting) return
    if (shareRecipientType === 'user' && !shareRecipientUserId) return
    if (shareRecipientType === 'external' && !shareRecipientEmail) return
    const attributeKeys = resolveShareAttributeKeys()
    // Story 20.5 AC-9: an explicit, non-null selection must name at least one field — "nothing
    // checked" is not a meaningful third state (and the backend's own `.min(1)` would reject an
    // explicit `[]` as ambiguous against `null`'s "whole-resource" meaning).
    if (attributeKeys !== null && attributeKeys.length === 0) {
      shareError = 'Select at least one field to share, or restore the defaults.'
      return
    }
    // UX gap fix: the backend rejects more than 50 explicit attributeKeys with a generic 422 —
    // catch it here with a message that actually explains why, before ever submitting.
    if (attributeKeys !== null && attributeKeys.length > SHARE_ATTRIBUTE_KEYS_MAX) {
      shareError = `You can share at most ${SHARE_ATTRIBUTE_KEYS_MAX} fields at once. Uncheck some fields, or restore the defaults to share the whole secret.`
      return
    }
    // Bugfix (post-implementation review): a credential whose fields are ALL sensitive — including
    // a legacy single-value credential, whose one implicit field is always `sensitive: true` per
    // `fieldMetaForResponse`'s existing convention — resolves to the default whole-resource
    // selection (`attributeKeys: null`) with every checkbox unchecked. That is a legitimate
    // "default" per `resolveShareAttributeKeys`, but AC-2's sensitivity-default-exclusion means it
    // always reveals as an empty field set. The field-picker below already renders a checkbox for
    // every entry in `fieldMeta` (including the legacy single-value fallback), so the sharer
    // always has a way to opt in explicitly; this guard just stops them from submitting a share
    // that can never disclose anything without first doing so, using the same message as the
    // explicit-empty-selection case above.
    if (
      attributeKeys === null &&
      fieldMeta.length > 0 &&
      fieldMeta.every((field) => field.sensitive)
    ) {
      shareError =
        'Every field on this secret is sensitive, so the default share would include nothing. Check at least one field to share explicitly.'
      return
    }
    shareSubmitting = true
    shareError = null
    lastCreatedShareToken = null
    const requestKey = credentialKey
    try {
      const expiresAt = new Date(Date.now() + shareExpiresInHours * 60 * 60 * 1000).toISOString()
      if (shareRecipientType === 'external') {
        const created = await createExternalCredentialShare(fetch, projectId, credentialId, {
          recipientEmail: shareRecipientEmail,
          attributeKeys,
          expiresAt,
          ...(shareStepUpPassword ? { password: shareStepUpPassword } : {}),
          ...(shareStepUpTotp ? { totpCode: shareStepUpTotp } : {}),
        })
        if (!isCurrentCredential(requestKey)) return
        const { token, ...summary } = created
        // Story 28.7 AC3: a newly created share is never 'revoked' — if an active status filter
        // wouldn't match it, splicing it into `shareItems` (and bumping the total) would show
        // something a full reload against the same filtered URL never would.
        if (matchesActiveSharesFilter(summary.status)) addShareLocally(summary)
        lastCreatedShareToken = token
        lastCreatedShareIsExternal = true
        shareRecipientEmail = ''
      } else {
        const created = await createCredentialShare(fetch, projectId, credentialId, {
          recipientUserId: shareRecipientUserId,
          attributeKeys,
          expiresAt,
          singleUse: shareSingleUse,
        })
        if (!isCurrentCredential(requestKey)) return
        const { token, ...summary } = created
        if (matchesActiveSharesFilter(summary.status)) addShareLocally(summary)
        lastCreatedShareToken = token
        lastCreatedShareIsExternal = false
        shareRecipientUserId = ''
      }
      shareAttributeOverrides = {}
    } catch (error) {
      if (!isCurrentCredential(requestKey)) return
      // Story 28.5 AC4/AC6: share creation now rejects with 410 against an archived secret.
      const archivedBanner = archivedBannerFor(error)
      shareError =
        archivedBanner ?? (error instanceof Error ? error.message : 'Could not create share.')
    } finally {
      // Cleared after every attempt, success or failure — never retained beyond the single
      // submit, including when step-up itself is what failed.
      shareStepUpPassword = ''
      shareStepUpTotp = ''
      shareSubmitting = false
    }
  }

  async function onRevokeShare(shareId: string): Promise<void> {
    if (revokingShareId) return
    revokingShareId = shareId
    shareError = null
    try {
      const updated = await revokeCredentialShare(fetch, projectId, credentialId, shareId)
      shareItems = shareItems.map((item) => (item.id === shareId ? updated : item))
    } catch (error) {
      shareError = error instanceof Error ? error.message : 'Could not revoke share.'
    } finally {
      revokingShareId = null
    }
  }

  // Story 20.5 AC-9 bugfix (review patch — supersedes an earlier `$effect`-based reset that
  // cleared EVERY override whenever the field-key set changed at all, e.g. an unrelated field
  // being added elsewhere on the credential, silently discarding a sharer's already-made
  // sensitive-field opt-in choice before they ever got to submit. `shareAttributeOverrides` is
  // keyed by field key and is only ever meaningful for a field that still exists — rather than
  // mutating the raw overrides map on every field-set change, this derives the *effective*
  // overrides by filtering out entries for keys that no longer exist on the current version,
  // leaving every override for a field that's still present untouched regardless of what else
  // changed.
  const currentFieldKeys = $derived(new Set(fieldMeta.map((field) => field.key)))
  const effectiveShareAttributeOverrides = $derived(
    Object.fromEntries(
      Object.entries(shareAttributeOverrides).filter(([key]) => currentFieldKeys.has(key))
    )
  )
</script>

{#if shareError}
  <p class="mt-3 text-sm text-red-700">{shareError}</p>
{/if}

{#if lastCreatedShareToken}
  <div class="mt-4 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm">
    <p class="font-semibold text-amber-900">
      Share link created — copy it now, it will not be shown again.
    </p>
    <code class="mt-2 block break-all rounded-lg bg-white px-3 py-2 text-xs text-slate-900">
      {buildAbsoluteUrl(
        origin,
        lastCreatedShareIsExternal
          ? `/external-shares/${lastCreatedShareToken}`
          : `/shares/${lastCreatedShareToken}`
      )}
    </code>
    {#if lastCreatedShareIsExternal}
      <p class="mt-2 text-xs text-amber-900">
        No in-app notification is sent to the recipient — send them this link yourself. Org admins
        have been notified a new external share was created.
      </p>
    {/if}
  </div>
{/if}

{#if orgRole !== 'viewer'}
  <!-- Story 17.2 AC-21: recipient-type toggle — org member (17.1) or external email. -->
  <div
    class="mt-4 flex gap-2 text-sm font-medium text-slate-700"
    role="radiogroup"
    aria-label="Share with"
  >
    <button
      type="button"
      class="rounded-full px-3 py-1 {shareRecipientType === 'user'
        ? 'bg-slate-950 text-white'
        : 'bg-slate-100 text-slate-700'}"
      aria-pressed={shareRecipientType === 'user'}
      onclick={() => onRecipientTypeChange('user')}
    >
      Org member
    </button>
    <button
      type="button"
      class="rounded-full px-3 py-1 {shareRecipientType === 'external'
        ? 'bg-slate-950 text-white'
        : 'bg-slate-100 text-slate-700'}"
      aria-pressed={shareRecipientType === 'external'}
      onclick={() => onRecipientTypeChange('external')}
    >
      External (email)
    </button>
  </div>

  <div class="mt-4 grid gap-3 sm:grid-cols-2">
    {#if shareRecipientType === 'user'}
      <label class="text-sm font-medium text-slate-700">
        Recipient
        <select
          class="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
          bind:value={shareRecipientUserId}
          aria-describedby="share-recipient-user-help"
        >
          <option value="">Select an org member…</option>
          {#each shareableOrgMembers as member (member.userId)}
            <option value={member.userId}>{member.displayName || member.email}</option>
          {/each}
        </select>
        <FormHelpText id="share-recipient-user-help" kind="select" />
      </label>
    {:else}
      <label class="text-sm font-medium text-slate-700">
        Recipient email
        <input
          type="email"
          class="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
          placeholder="vendor@example.com"
          bind:value={shareRecipientEmail}
          aria-describedby="share-recipient-email-help"
        />
        <FormHelpText id="share-recipient-email-help" kind="text" />
      </label>
    {/if}

    <label class="text-sm font-medium text-slate-700">
      Expires in (hours)
      <input
        type="number"
        min="1"
        max={shareRecipientType === 'external' ? EXTERNAL_SHARE_MAX_HOURS : MEMBER_SHARE_MAX_HOURS}
        class="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
        bind:value={shareExpiresInHours}
        aria-describedby="share-expiry-help"
      />
      <FormHelpText id="share-expiry-help" kind="date" />
    </label>

    {#if shareRecipientType === 'user'}
      <label class="mt-6 flex items-center gap-2 text-sm font-medium text-slate-700">
        <input
          type="checkbox"
          bind:checked={shareSingleUse}
          aria-describedby="share-single-use-help"
        />
        Single view only
        <FormHelpText id="share-single-use-help" kind="checkbox" />
      </label>
    {:else}
      <!-- Story 17.2 AC-5: singleUse is hard-coded true server-side for external shares —
           the toggle is never shown/editable for this recipient type. -->
      <p class="mt-6 text-sm text-slate-500">Single view only (always on for external shares)</p>
    {/if}
  </div>

  <!-- Story 20.5 AC-9: attribute-keys selection — one checkbox per available field, plus
       sensitivity-default-exclusion shown (not hidden): a sensitive field renders unchecked
       by default with a visible "excluded by default" badge, so the sharer sees before
       submitting which fields won't be shared unless explicitly opted in. Every non-
       sensitive field renders checked by default. Unchecking a default-included field, or
       checking a default-excluded sensitive field, produces an explicit `attributeKeys`
       list; leaving every field at its default sends `attributeKeys: null` (whole-resource,
       identical to today's behavior). Shared by both recipient-type forms above. -->
  <fieldset class="mt-4" aria-describedby="share-attribute-keys-help">
    <legend class="text-sm font-medium text-slate-700">Fields to share</legend>
    <div class="mt-1 flex flex-col gap-1.5">
      {#each fieldMeta as field (field.key)}
        <label class="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={isShareAttributeChecked(field)}
            aria-describedby="share-attribute-keys-help"
            onchange={() => toggleShareAttribute(field)}
          />
          {field.key}
          {#if field.sensitive}
            <span
              class="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-900"
            >
              Sensitive — excluded by default
            </span>
          {/if}
        </label>
      {/each}
    </div>
    <FormHelpText id="share-attribute-keys-help" kind="checkbox" />
  </fieldset>

  {#if shareRecipientType === 'external'}
    <!-- Story 17.2 AC-3: step-up re-authentication, required before creating an external
         share — password or a fresh TOTP code, whichever factor the sharer has. -->
    <div class="mt-4 grid gap-3 sm:grid-cols-2">
      <label class="text-sm font-medium text-slate-700">
        Confirm your password
        <input
          type="password"
          class="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
          bind:value={shareStepUpPassword}
          autocomplete="current-password"
          aria-describedby="share-step-up-password-help"
        />
        <FormHelpText id="share-step-up-password-help" kind="secret" />
      </label>
      <label class="text-sm font-medium text-slate-700">
        or a fresh authenticator code
        <input
          type="text"
          inputmode="numeric"
          class="mt-1 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm"
          bind:value={shareStepUpTotp}
          aria-describedby="share-step-up-totp-help"
        />
        <FormHelpText id="share-step-up-totp-help" kind="secret" />
      </label>
    </div>
  {/if}

  <button
    type="button"
    class="mt-4 inline-block rounded-xl bg-slate-950 px-4 py-3 text-sm font-semibold text-white disabled:opacity-50"
    disabled={shareSubmitting ||
      isArchived ||
      (shareRecipientType === 'user' ? !shareRecipientUserId : !shareRecipientEmail)}
    onclick={onCreateShare}
  >
    {shareSubmitting ? 'Creating…' : 'Create share link'}
  </button>
{/if}

<div class="mt-6 flex flex-wrap items-center justify-between gap-3">
  <h3 class="font-semibold text-slate-950">Outstanding and past shares</h3>
  <!-- Story 17.3 AC-1: status filter, driven by the sharesStatus URL query param so the
       filter survives a reload/shared link, same convention as the rotations `page` param. -->
  <label class="text-sm text-slate-600">
    Filter by status
    <select
      class="ml-2 rounded-lg border border-slate-300 px-2 py-1 text-sm"
      value={sharesStatus ?? ''}
      onchange={(e) => {
        const value = (e.target as HTMLSelectElement).value
        const url = new URL(window.location.href)
        if (value) url.searchParams.set('sharesStatus', value)
        else url.searchParams.delete('sharesStatus')
        url.searchParams.delete('sharesPage')
        window.location.href = url.toString()
      }}
      aria-describedby="shares-status-help"
    >
      <option value="">All</option>
      <option value="active">Active</option>
      <option value="viewed">Viewed</option>
      <option value="revoked">Revoked</option>
      <option value="expired">Expired</option>
      <option value="superseded">Superseded</option>
    </select>
    <FormHelpText id="shares-status-help" kind="select" />
  </label>
</div>
{#if shareItems.length === 0}
  <p class="mt-3 text-sm text-slate-600">No shares yet for this secret.</p>
{:else}
  <p class="mt-2 text-xs text-slate-500">
    Showing {shareItems.length} of {sharesTotalCount}
  </p>
  <ul class="mt-2 space-y-2">
    {#each shareItems as share (share.id)}
      <li
        class="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 px-4 py-3 text-sm"
      >
        <span class="font-medium text-slate-950">
          Fields: {shareScopeLabel(share)}
        </span>
        <span class="text-slate-600">
          {#if share.recipientType === 'external'}
            {share.recipientEmail} (external)
          {:else}
            {shareableOrgMembers.find((m) => m.userId === share.recipientUserId)?.displayName ??
              shareableOrgMembers.find((m) => m.userId === share.recipientUserId)?.email ??
              'org member'}
          {/if}
        </span>
        <span class="text-slate-600">created {formatDateTime(share.createdAt)}</span>
        <span class="text-slate-600">expires {formatDateTime(share.expiresAt)}</span>
        <span class="text-slate-600">
          {share.firstViewedAt ? `viewed ${formatDateTime(share.firstViewedAt)}` : 'not viewed'}
        </span>
        <span
          class="rounded-full bg-slate-100 px-2 py-1 text-xs font-semibold uppercase text-slate-700"
        >
          {share.status}
        </span>
        {#if share.status === 'active'}
          <button
            type="button"
            class="text-sm font-medium text-red-700 underline disabled:opacity-50"
            disabled={revokingShareId === share.id}
            onclick={() => onRevokeShare(share.id)}
          >
            Revoke
          </button>
        {/if}
      </li>
    {/each}
  </ul>
  <!-- Story 17.3 AC-2: pagination controls — Prev/Next, driven by the sharesPage URL query
       param, so a page reload/shared link preserves position. -->
  <div class="mt-3 flex items-center gap-3">
    {#if (sharesPage ?? 1) > 1}
      <a
        class="text-sm font-medium text-slate-700 underline"
        href={resolve(
          `/projects/${projectId}/credentials/${credentialId}?${sharesPageQuery((sharesPage ?? 1) - 1)}`
        )}
      >
        Previous
      </a>
    {/if}
    {#if (sharesPage ?? 1) * 25 < (sharesTotal ?? 0)}
      <a
        class="text-sm font-medium text-slate-700 underline"
        href={resolve(
          `/projects/${projectId}/credentials/${credentialId}?${sharesPageQuery((sharesPage ?? 1) + 1)}`
        )}
      >
        Next
      </a>
    {/if}
  </div>
{/if}
