<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import { invalidateAll } from '$app/navigation'
  import { resolve } from '$app/paths'
  import type { FieldMeta, SystemType } from '@project-vault/shared'
  import {
    buildAbsoluteUrl,
    DEFAULT_FIELD_KEY,
    nextCronOccurrence,
    describeRotationCron,
    validateRotationCron,
  } from '@project-vault/shared'
  import {
    addCredentialDependency,
    addCredentialVersion,
    archiveCredentialDependency,
    isFieldsValue,
    listCredentialDependencies,
    parseRevealedFields,
    revealCredentialValue,
    updateCredentialLifecycle,
    type CredentialDependencyWithChecklistStatus,
  } from '$lib/api/credentials.js'
  import { confirmChecklistItem } from '$lib/api/rotations.js'
  import {
    createCredentialShare,
    createExternalCredentialShare,
    dismissRotationRecommendedNudge,
    revokeCredentialShare,
    type CredentialShareSummary,
    type RotationRecommendedBucket,
  } from '$lib/api/credential-shares.js'
  import { ApiClientError } from '$lib/api/client.js'
  import FieldSetEditor from '$lib/components/credentials/FieldSetEditor.svelte'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'
  import CronScheduleHelp from '$lib/components/forms/CronScheduleHelp.svelte'
  import {
    canCreateCredential,
    mapCredentialSubmitError,
    onboardingCopy,
    validateFieldSet,
    type FieldDraft,
  } from '$lib/components/onboarding/onboarding-logic.js'
  import {
    lifecycleDateInputToIso,
    toLifecycleDateInputValue,
  } from '$lib/credentials/lifecycle-form.js'
  import PageAlertBanner from '$lib/components/PageAlertBanner.svelte'
  import { m } from '$lib/paraglide/messages.js'
  import { getLocale } from '$lib/paraglide/runtime.js'
  import { canManageRotations } from '$lib/components/rotations/rotation-permissions.js'
  import {
    formatDateTime,
    rotationCopy,
    rotationStatusBadgeClass,
  } from '$lib/components/rotations/rotation-copy.js'

  let { data } = $props()

  // AC-L4/AC-D5/AC-V4: the UI has no way to know ahead of time that the parent project is
  // archived, so every mutation on this page reacts to the real 410 the same way, with the same
  // copy, rather than each section growing its own bespoke banner text.
  const ARCHIVED_PROJECT_BANNER = 'This project is archived — unarchive it to make changes.'

  let revealedValue = $state<string | null>(null)
  let revealVersion = $state<number | null>(null)
  let revealing = $state(false)
  let revealError = $state<string | null>(null)

  // Story 13.3 — per-field reveal/mask state for a genuinely multi-field secret. `revealedFields`
  // holds explicitly-revealed sensitive field values (and any non-sensitive field whose eager
  // decrypt degraded — AC-2 Failure Mode). "Hide" clears a key client-side only, no API call,
  // mirroring the existing whole-secret `revealedValue = null` convention.
  let revealedFields = $state<Record<string, string>>({})
  let revealingField = $state<string | null>(null)
  let fieldRevealError = $state<Record<string, string>>({})
  let revealAllLoading = $state(false)
  let revealAllError = $state<string | null>(null)

  // AC-L1: local override applied after a successful lifecycle save so the read-only summary
  // grid above updates without a full page reload; null means "show data.credential's value".
  let lifecycleOverride = $state<{
    expiresAt: string | null
    rotationSchedule: string | null
  } | null>(null)
  let lifecycleExpiresAt = $state(toLifecycleDateInputValue(data.credential?.expiresAt ?? null))
  let lifecycleRotationSchedule = $state(data.credential?.rotationSchedule ?? '')
  // AC-L1: pre-fill from the credential detail's real cacheable flag (defaults only when the
  // detail is missing — never hardcode `true`, which would silently re-enable caching on save).
  let lifecycleCacheable = $state(data.credential?.cacheable ?? true)
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

  const canReveal = $derived(canCreateCredential(data.orgRole))
  const canManageRotation = $derived(canManageRotations(data.orgRole))
  const displayExpiresAt = $derived(
    lifecycleOverride ? lifecycleOverride.expiresAt : (data.credential?.expiresAt ?? null)
  )

  async function onSaveLifecycle(): Promise<void> {
    if (lifecycleSubmitting || !data.credential) return
    lifecycleSubmitting = true
    lifecycleFieldError = null
    lifecycleBanner = null
    try {
      const result = await updateCredentialLifecycle(fetch, data.projectId, data.credentialId, {
        expiresAt: lifecycleDateInputToIso(lifecycleExpiresAt),
        rotationSchedule:
          lifecycleRotationSchedule.trim() === '' ? null : lifecycleRotationSchedule,
        cacheable: lifecycleCacheable,
      })
      lifecycleOverride = { expiresAt: result.expiresAt, rotationSchedule: result.rotationSchedule }
    } catch (error) {
      if (error instanceof ApiClientError && error.code === 'invalid_cron') {
        lifecycleFieldError = error.message
      } else if (error instanceof ApiClientError && error.status === 410) {
        lifecycleBanner = ARCHIVED_PROJECT_BANNER
      } else {
        lifecycleFieldError =
          error instanceof Error ? error.message : 'Could not update lifecycle fields.'
      }
    } finally {
      lifecycleSubmitting = false
    }
  }

  // AC-D1: local list so a successful add/archive updates the UI immediately without a reload;
  // seeded once from the loader's data, same "state_referenced_locally" convention used elsewhere
  // on this page (see lifecycleExpiresAt above) and on the projects list page's tag inputs.
  let dependencyItems = $state<CredentialDependencyWithChecklistStatus[]>(data.dependencies.items)
  let depSystemName = $state('')
  let depSystemType = $state<SystemType>('other')
  let depNotes = $state('')
  let depLinkUrl = $state('')
  // Story 13.5 AC-6: '' means "Whole credential" (omitted fieldKey), matching the rotation
  // field-selector's own field_meta.length > 1 gating convention (Story 13.4).
  let depFieldKey = $state('')
  let depSubmitting = $state(false)
  let depNameError = $state<string | null>(null)
  let depError = $state<string | null>(null)
  let depBanner = $state<string | null>(null)
  let archivingDependencyId = $state<string | null>(null)
  // AC-5: authoritative server-computed flag — never inferred from whether any item has a
  // non-null checklistStatus (ADR-2.10-02, see the story's "Challenge from Critical Perspective"
  // finding for why the naive inference is wrong when every dependency post-dates staging).
  // Story 18.7: promoted to local $state (same "state_referenced_locally" convention as
  // `dependencyItems` above) so the background poll below can update it in place without a full
  // page reload.
  let hasStagedRotation = $state(data.dependencies.hasStagedRotation)
  let confirmingDependencyId = $state<string | null>(null)
  let checklistError = $state<string | null>(null)
  // Story 18.7 AC-5: "Add dependent system" starts collapsed behind a native <details>/<summary>
  // disclosure — simple client-side UI state, not persisted across reloads (AC-6).
  let dependencyFormOpen = $state(false)

  // Story 17.1 AC-11: local list, same "state_referenced_locally" convention the dependency
  // section above uses — updated in place on create/revoke so the Shares tab reflects a mutation
  // immediately without a full reload.
  let shareItems = $state<CredentialShareSummary[]>(data.shares ?? [])
  // Story 17.2 AC-21: recipient-type toggle — swaps the org-member typeahead for a plain email
  // input, and surfaces the tighter 1h default/72h cap plus the step-up prompt when 'external'.
  let shareRecipientType = $state<'user' | 'external'>('user')
  let shareRecipientUserId = $state('')
  let shareRecipientEmail = $state('')
  // Story 20.5 AC-9: attribute-key selection for the create-share form. Only explicit deviations
  // from the default ("all non-sensitive fields included, all sensitive fields excluded") are
  // stored here — the effective checked state for a given field is computed by
  // `isShareAttributeChecked` below, so this map never needs to be rebuilt when the field set
  // changes (e.g. after an in-place field-set edit re-fetches `data.credential`). Shared by both
  // the member and external create forms (same UI, same state) since AC-9 does not distinguish.
  let shareAttributeOverrides = $state<Record<string, boolean>>({})
  let shareExpiresInHours = $state(24)
  let shareSingleUse = $state(true)
  // Story 17.2 AC-3: step-up re-authentication, required before an external share can be
  // created. Cleared after every attempt — never retained beyond the single submit.
  let shareStepUpPassword = $state('')
  let shareStepUpTotp = $state('')
  let shareSubmitting = $state(false)
  let shareError = $state<string | null>(null)
  // Story 17.1 AC-11: the raw token is shown exactly once, right after creation (copy-once
  // affordance) — never persisted, never re-fetchable once this local state is cleared/replaced.
  let lastCreatedShareToken = $state<string | null>(null)
  let lastCreatedShareIsExternal = $state(false)
  let revokingShareId = $state<string | null>(null)

  // Story 17.3 AC-11/AC-16: local list, same convention as `shareItems` above — updated in place
  // on dismiss so the badge disappears immediately without a full reload.
  let nudgeBuckets = $state<RotationRecommendedBucket[]>(data.rotationRecommendedNudges ?? [])
  let dismissingBucketKey = $state<string | null>(null)
  let dismissReason = $state('')
  let dismissError = $state<string | null>(null)
  const activeNudgeBuckets = $derived(nudgeBuckets.filter((bucket) => bucket.active))

  function bucketKey(fieldKey: string | null): string {
    return fieldKey ?? '__whole_credential__'
  }

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
    if (data.sharesStatus) params.set('sharesStatus', data.sharesStatus)
    params.set('sharesPage', String(targetPage))
    return params.toString()
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
    if (!dismissReason.trim() || !data.credential) return
    dismissError = null
    try {
      await dismissRotationRecommendedNudge(fetch, data.projectId, data.credentialId, {
        ...(fieldKey ? { fieldKey } : {}),
        reason: dismissReason,
      })
      nudgeBuckets = nudgeBuckets.map((bucket) =>
        bucket.fieldKey === fieldKey ? { ...bucket, active: false } : bucket
      )
      dismissingBucketKey = null
      dismissReason = ''
    } catch (error) {
      dismissError =
        error instanceof ApiClientError ? error.message : 'Failed to dismiss the nudge.'
    }
  }

  const EXTERNAL_SHARE_DEFAULT_HOURS = 1
  const EXTERNAL_SHARE_MAX_HOURS = 72
  const MEMBER_SHARE_MAX_HOURS = 168
  // Mirrors the backend's `AttributeKeysSchema.max(50)` (apps/api/src/modules/credential-shares/
  // schema.ts) — a client-side equivalent so a sharer who checks more than 50 boxes on a
  // many-field credential gets a specific, actionable message here rather than a generic
  // "Could not create share" after a round-trip 422.
  const SHARE_ATTRIBUTE_KEYS_MAX = 50

  const shareableOrgMembers = $derived(data.orgMembers ?? [])

  // Story 20.5 AC-9: a field's effective checked state in the create-share attribute picker — the
  // explicit override if the user toggled it away from default, otherwise the default itself
  // (non-sensitive => included, sensitive => excluded). Reused by both the checkbox rendering and
  // `resolveShareAttributeKeys` below so the two can never disagree on what "checked" means.
  function isShareAttributeChecked(field: FieldMeta): boolean {
    // Bugfix (review patch): `Object.hasOwn` instead of the `in` operator — `in` also matches
    // inherited `Object.prototype` properties, so a field literally named `constructor`/
    // `toString`/`hasOwnProperty`/etc. would get a false-positive "overridden" state via
    // prototype inheritance rather than falling through to the sensitivity-based default.
    return Object.hasOwn(effectiveShareAttributeOverrides, field.key)
      ? effectiveShareAttributeOverrides[field.key]
      : !field.sensitive
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
    if (shareSubmitting || !data.credential) return
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
      shareError = `You can share at most ${SHARE_ATTRIBUTE_KEYS_MAX} fields at once. Uncheck some fields, or restore the defaults to share the whole credential.`
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
        'Every field on this credential is sensitive, so the default share would include nothing. Check at least one field to share explicitly.'
      return
    }
    shareSubmitting = true
    shareError = null
    lastCreatedShareToken = null
    try {
      const expiresAt = new Date(Date.now() + shareExpiresInHours * 60 * 60 * 1000).toISOString()
      if (shareRecipientType === 'external') {
        const created = await createExternalCredentialShare(
          fetch,
          data.projectId,
          data.credentialId,
          {
            recipientEmail: shareRecipientEmail,
            attributeKeys,
            expiresAt,
            ...(shareStepUpPassword ? { password: shareStepUpPassword } : {}),
            ...(shareStepUpTotp ? { totpCode: shareStepUpTotp } : {}),
          }
        )
        const { token, ...summary } = created
        shareItems = [summary, ...shareItems]
        lastCreatedShareToken = token
        lastCreatedShareIsExternal = true
        shareRecipientEmail = ''
      } else {
        const created = await createCredentialShare(fetch, data.projectId, data.credentialId, {
          recipientUserId: shareRecipientUserId,
          attributeKeys,
          expiresAt,
          singleUse: shareSingleUse,
        })
        const { token, ...summary } = created
        shareItems = [summary, ...shareItems]
        lastCreatedShareToken = token
        lastCreatedShareIsExternal = false
        shareRecipientUserId = ''
      }
      shareAttributeOverrides = {}
    } catch (error) {
      shareError = error instanceof Error ? error.message : 'Could not create share.'
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
      const updated = await revokeCredentialShare(fetch, data.projectId, data.credentialId, shareId)
      shareItems = shareItems.map((item) => (item.id === shareId ? updated : item))
    } catch (error) {
      shareError = error instanceof Error ? error.message : 'Could not revoke share.'
    } finally {
      revokingShareId = null
    }
  }

  async function onAddDependency(): Promise<void> {
    if (depSubmitting || !data.credential) return
    const systemName = depSystemName.trim()
    if (!systemName) {
      depNameError = m.form_error_dependency_system_name_required()
      return
    }
    depSubmitting = true
    depNameError = null
    depError = null
    depBanner = null
    try {
      const notes = depNotes.trim()
      const linkUrl = depLinkUrl.trim()
      const created = await addCredentialDependency(fetch, data.projectId, data.credentialId, {
        systemName,
        systemType: depSystemType,
        ...(notes ? { notes } : {}),
        ...(linkUrl ? { linkUrl } : {}),
        ...(depFieldKey ? { fieldKey: depFieldKey } : {}),
      })
      dependencyItems = [...dependencyItems, { ...created, checklistStatus: null }]
      depSystemName = ''
      depSystemType = 'other'
      depNotes = ''
      depLinkUrl = ''
      depFieldKey = ''
    } catch (error) {
      if (error instanceof ApiClientError && error.status === 410) {
        depBanner = ARCHIVED_PROJECT_BANNER
      } else if (
        error instanceof ApiClientError &&
        (error.code === 'too_many_dependencies' ||
          error.code === 'invalid_link_url' ||
          error.code === 'unknown_field_key')
      ) {
        depError = error.message
      } else {
        depError = error instanceof Error ? error.message : 'Could not add dependent system.'
      }
    } finally {
      depSubmitting = false
    }
  }

  async function onArchiveDependency(dependencyId: string): Promise<void> {
    if (archivingDependencyId || !data.credential) return
    archivingDependencyId = dependencyId
    depBanner = null
    try {
      await archiveCredentialDependency(fetch, data.projectId, data.credentialId, dependencyId)
      dependencyItems = dependencyItems.filter((item) => item.id !== dependencyId)
    } catch (error) {
      if (error instanceof ApiClientError && error.status === 410) {
        depBanner = ARCHIVED_PROJECT_BANNER
      } else {
        depError = error instanceof Error ? error.message : 'Could not archive dependent system.'
      }
    } finally {
      archivingDependencyId = null
    }
  }

  // AC-6.2/6.3: checking the box calls the EXISTING checklist confirm route unchanged — only the
  // caller (this dependency-list surface) is new. Un-checking is not supported (confirm is a
  // one-way pending/failed -> confirmed transition, matching the rotation detail page's own
  // checklist UI — Story 5.2).
  async function onConfirmDependencyUpdate(
    dependency: CredentialDependencyWithChecklistStatus
  ): Promise<void> {
    if (!data.credential || confirmingDependencyId) return
    const status = dependency.checklistStatus
    if (!status || status.status === 'confirmed') return
    confirmingDependencyId = dependency.id
    checklistError = null
    try {
      const result = await confirmChecklistItem(
        fetch,
        data.projectId,
        data.credentialId,
        status.rotationId,
        status.itemId
      )
      dependencyItems = dependencyItems.map((item) =>
        item.id === dependency.id && item.checklistStatus
          ? {
              ...item,
              checklistStatus: {
                ...item.checklistStatus,
                status: result.item.status,
                confirmedBy: result.item.confirmedBy,
                confirmedAt: result.item.confirmedAt,
              },
            }
          : item
      )
    } catch (error) {
      // Example 6b: a 409 already_confirmed (someone else confirmed it first, e.g. from the
      // rotation detail page in another tab) is a success from Morgan's perspective — reconcile
      // local state from the error body instead of surfacing an error toast.
      if (error instanceof ApiClientError && error.code === 'already_confirmed') {
        const body = error.body as {
          confirmedBy?: string | null
          confirmedAt?: string | null
        } | null
        dependencyItems = dependencyItems.map((item) =>
          item.id === dependency.id && item.checklistStatus
            ? {
                ...item,
                checklistStatus: {
                  ...item.checklistStatus,
                  status: 'confirmed',
                  confirmedBy: body?.confirmedBy ?? item.checklistStatus.confirmedBy,
                  confirmedAt: body?.confirmedAt ?? item.checklistStatus.confirmedAt,
                },
              }
            : item
        )
      } else {
        checklistError = error instanceof Error ? error.message : 'Could not confirm update.'
      }
    } finally {
      confirmingDependencyId = null
    }
  }

  // Story 18.7 AC-1/2/3: this checkbox is Story 2.10's rotation-checklist "Updated" confirmation
  // control, not a permanently-dead one — it's real, functional state, just only meaningful while
  // (a) a rotation is currently staged AND (b) this specific dependency is tracked by that
  // rotation's checklist (a dependency added after staging has no checklist entry to confirm).
  // Both conditions gate on genuine state, so per AC-4's decision rule ("favor conditional-hide
  // if it gates on any real state") an inapplicable checkbox is hidden entirely rather than shown
  // permanently disabled with an unreadable tooltip.
  function isDependencyCheckboxRelevant(
    dependency: CredentialDependencyWithChecklistStatus
  ): boolean {
    return hasStagedRotation && dependency.checklistStatus !== null
  }

  // Story 18.7 AC-3: keeps the checkbox's relevance reactive to the credential's rotation state
  // while the page stays open — mirrors the rotation detail page's own visibility-aware 15s poll
  // (apps/web/.../rotations/[rotationId]/+page.svelte) so a user already on this page sees the
  // control appear/disappear without a reload as a rotation starts, finishes, or is retired.
  let dependencyPollTimer: ReturnType<typeof setInterval> | undefined

  function clearDependencyPoll() {
    if (dependencyPollTimer) clearInterval(dependencyPollTimer)
    dependencyPollTimer = undefined
  }

  async function refetchDependencies(): Promise<void> {
    // Skip a tick while any dependency-mutating request is in flight (confirm, archive, or add)
    // — that request's own response already reconciles local state (including a 409
    // already_confirmed for confirm), and a stale poll response landing after it completes but
    // reflecting pre-mutation server state would silently clobber/resurrect the mutated row until
    // the next tick corrects it.
    if (!data.credential || confirmingDependencyId || archivingDependencyId || depSubmitting) return
    try {
      const result = await listCredentialDependencies(fetch, data.projectId, data.credentialId)
      dependencyItems = result.items
      hasStagedRotation = result.hasStagedRotation
    } catch {
      // Best-effort background refresh: a failed poll just leaves the last-known state in place
      // and is retried on the next tick, matching the rotation detail page's own poll convention
      // — surfacing an error here would be noisier than useful for this background nicety.
    }
  }

  function scheduleDependencyPoll() {
    clearDependencyPoll()
    if (!data.credential || dependencyItems.length === 0) return
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    dependencyPollTimer = setInterval(() => {
      void refetchDependencies()
    }, 15000)
  }

  function handleDependencyVisibilityChange() {
    if (typeof document === 'undefined') return
    if (document.visibilityState === 'hidden') clearDependencyPoll()
    else scheduleDependencyPoll()
  }

  $effect(() => {
    // Re-evaluated whenever the dependency list count changes (e.g. the first dependency is
    // added, or the last one is archived), so polling starts/stops accordingly.
    dependencyItems.length
    scheduleDependencyPoll()
  })

  onMount(() => {
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleDependencyVisibilityChange)
    }
  })

  onDestroy(() => {
    clearDependencyPoll()
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', handleDependencyVisibilityChange)
    }
    revealedValue = null
    revealVersion = null
    revealedFields = {}
    if (copyStatusTimeout) clearTimeout(copyStatusTimeout)
  })

  // Story 13.3 AC-4 — reveal exactly one field. `GET .../value?field=<key>` is called; only that
  // field's value comes back and only that field is written to `revealedFields`.
  async function revealSingleField(key: string): Promise<void> {
    if (revealingField || !canReveal || !data.credential) return
    revealingField = key
    fieldRevealError = { ...fieldRevealError, [key]: '' }
    try {
      const result = await revealCredentialValue(fetch, data.projectId, data.credentialId, {
        field: key,
      })
      const value = isFieldsValue(result) ? (result.fields[0]?.value ?? '') : result.value
      revealedFields = { ...revealedFields, [key]: value }
    } catch (error) {
      // AC-7/Subtask 3.5 — surface `unknown_field_key` inline near the affected row (e.g. a stale
      // field list after a concurrent rename) rather than as a generic top-level banner.
      if (error instanceof ApiClientError && error.code === 'unknown_field_key') {
        fieldRevealError = {
          ...fieldRevealError,
          [key]: 'This field no longer exists on this secret — refresh the page.',
        }
      } else {
        fieldRevealError = {
          ...fieldRevealError,
          [key]: error instanceof Error ? error.message : 'Could not reveal this field.',
        }
      }
    } finally {
      revealingField = null
    }
  }

  // Story 13.3 Subtask 3.4 — clears the field's in-memory revealed value only; no API call, same
  // convention as the existing whole-secret `revealedValue = null` "Hide".
  function hideField(key: string): void {
    const next = { ...revealedFields }
    delete next[key]
    revealedFields = next
  }

  // Story 13.3 AC-5/Subtask 3.2 — whole-secret reveal for a multi-field secret: every returned
  // field is rendered in its own row (never as one opaque blob, replacing the old raw-JSON dump).
  async function revealAllFields(): Promise<void> {
    if (revealAllLoading || !canReveal || !data.credential) return
    revealAllLoading = true
    revealAllError = null
    try {
      const result = await revealCredentialValue(fetch, data.projectId, data.credentialId)
      if (isFieldsValue(result)) {
        const updates: Record<string, string> = {}
        for (const field of result.fields) {
          if (field.sensitive) updates[field.key] = field.value
        }
        revealedFields = { ...revealedFields, ...updates }
      }
    } catch (error) {
      revealAllError = error instanceof Error ? error.message : 'Could not reveal all fields.'
    } finally {
      revealAllLoading = false
    }
  }

  async function revealValue() {
    if (revealing || !canReveal || !data.credential) return
    revealing = true
    revealError = null
    try {
      const result = await revealCredentialValue(fetch, data.projectId, data.credentialId)
      revealedValue = result.value
      revealVersion = result.versionNumber
    } catch (error) {
      revealedValue = null
      revealVersion = null
      if (error instanceof ApiClientError && error.code === 'insufficient_project_role') {
        revealError =
          'Your role in this project does not permit revealing credential values — ask a project admin to change your role.'
      } else if (error instanceof ApiClientError && error.status === 403) {
        revealError = 'You do not have permission to reveal credential values.'
      } else {
        revealError = error instanceof Error ? error.message : 'Could not reveal value.'
      }
    } finally {
      revealing = false
    }
  }

  // AC-20/21: mirrors the existing `role="status"`/`aria-live="polite"` "✓ Credential saved
  // securely" pattern used elsewhere on this same page — a brief, auto-dismissing, announced
  // confirmation (or failure message) rather than a silent no-op or an unhandled rejection.
  let copyStatus = $state<{ kind: 'success' | 'failure'; message: string } | null>(null)
  let copyStatusTimeout: ReturnType<typeof setTimeout> | null = null

  function showCopyStatus(kind: 'success' | 'failure', message: string) {
    if (copyStatusTimeout) clearTimeout(copyStatusTimeout)
    copyStatus = { kind, message }
    copyStatusTimeout = setTimeout(() => {
      copyStatus = null
      copyStatusTimeout = null
    }, 3000)
  }

  async function copyValue() {
    if (!revealedValue) return
    try {
      await navigator.clipboard.writeText(revealedValue)
      showCopyStatus('success', 'Copied to clipboard')
    } catch {
      // Clipboard may be unavailable in some contexts (permissions denied, non-secure context).
      showCopyStatus('failure', "Couldn't copy — copy manually")
    }
  }

  let newVersionValue = $state('')
  let addingVersion = $state(false)
  let addVersionError = $state<string | null>(null)
  let addVersionBanner = $state<string | null>(null)

  // AC-V1: version history is re-fetched via `invalidateAll` (reruns +page.server.ts's load,
  // which calls the real `listCredentialVersions`), not client-synthesized — the POST response
  // alone lacks fields (createdBy, purgedAt, abandonedAt) needed to render a correct history row.
  async function onAddVersion(): Promise<void> {
    if (addingVersion || !data.credential) return
    const value = newVersionValue.trim()
    if (!value) {
      addVersionError = 'Value is required'
      return
    }
    addingVersion = true
    addVersionError = null
    addVersionBanner = null
    try {
      await addCredentialVersion(fetch, data.projectId, data.credentialId, { value })
      newVersionValue = ''
      await invalidateAll()
    } catch (error) {
      if (error instanceof ApiClientError && error.status === 410) {
        addVersionBanner = ARCHIVED_PROJECT_BANNER
      } else if (error instanceof ApiClientError && error.code === 'version_conflict') {
        addVersionError = 'Someone just added a version — refresh and try again.'
      } else {
        addVersionError = error instanceof Error ? error.message : 'Could not add version.'
      }
    } finally {
      addingVersion = false
    }
  }

  // Story 13.2 — the current version's field metadata (keys/sensitivity). A legacy schema_version=1
  // secret (or any single-default-field secret) renders as one unnamed masked field, identical to
  // its pre-Phase-2 appearance (AC-7); anything else renders the multi-field editor.
  const fieldMeta = $derived<FieldMeta[]>(
    data.credential?.fields ?? [{ key: DEFAULT_FIELD_KEY, sensitive: true }]
  )
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
  const isMultiField = $derived(
    fieldMeta.length > 1 || (fieldMeta[0]?.key ?? DEFAULT_FIELD_KEY) !== DEFAULT_FIELD_KEY
  )
  // Story 13.3 AC-2 — eagerly-decrypted non-sensitive field values from the detail response.
  // Empty for a legacy secret, a secret with no non-sensitive fields, or a degraded eager decrypt
  // (that field then falls back to the masked+Reveal treatment below, same as a sensitive field).
  const visibleFieldValues = $derived<Record<string, string>>(
    data.credential?.visibleFieldValues ?? {}
  )

  let editingFieldSet = $state(false)
  let editFields = $state<FieldDraft[]>([])
  let fieldSetErrors = $state<Record<number, string>>({})
  let fieldSetFormError = $state<string | null>(null)
  let loadingFieldSet = $state(false)

  // AC-8 — editing a sensitive field is a blind overwrite: we reveal current values only to
  // pre-fill the form so unchanged fields round-trip (AC-4); there is no "reveal to edit" gate and
  // the user can overwrite any field directly.
  async function startEditFieldSet(): Promise<void> {
    if (loadingFieldSet || !data.credential) return
    loadingFieldSet = true
    fieldSetFormError = null
    try {
      const revealed = await revealCredentialValue(fetch, data.projectId, data.credentialId)
      editFields = parseRevealedFields(fieldMeta, revealed).map((f) => ({ ...f }))
      fieldSetErrors = {}
      editingFieldSet = true
    } catch (error) {
      fieldSetFormError =
        error instanceof Error ? error.message : 'Could not load fields for editing.'
    } finally {
      loadingFieldSet = false
    }
  }

  function addEditField(): void {
    editFields = [...editFields, { key: '', value: '', sensitive: false }]
  }
  function removeEditField(index: number): void {
    editFields = editFields.filter((_, i) => i !== index)
    fieldSetErrors = {}
  }

  async function saveFieldSet(): Promise<void> {
    if (addingVersion || !data.credential) return
    const result = validateFieldSet(editFields)
    fieldSetErrors = result.fieldErrors
    if (!result.ok) {
      fieldSetFormError = result.formError ?? null
      return
    }
    addingVersion = true
    fieldSetFormError = null
    try {
      await addCredentialVersion(fetch, data.projectId, data.credentialId, {
        fields: editFields.map((f) => ({
          key: f.key.trim(),
          value: f.value,
          sensitive: f.sensitive,
        })),
      })
      editingFieldSet = false
      editFields = []
      await invalidateAll()
    } catch (error) {
      if (error instanceof ApiClientError && error.status === 410) {
        fieldSetFormError = ARCHIVED_PROJECT_BANNER
      } else {
        const mapped = mapCredentialSubmitError(error)
        fieldSetFormError = mapped.errorMessage
        if (mapped.fieldKeyConflict) {
          const idx = editFields.findIndex(
            (f) => f.key.trim().toLowerCase() === mapped.fieldKeyConflict?.toLowerCase()
          )
          if (idx >= 0) fieldSetErrors = { ...fieldSetErrors, [idx]: mapped.errorMessage }
        }
      }
    } finally {
      addingVersion = false
    }
  }
</script>

<svelte:head>
  <title>{data.credential?.name ?? 'Credential'} | Project Vault</title>
</svelte:head>

<section class="space-y-6">
  {#if data.vaultSealed}
    <PageAlertBanner title="Vault sealed" message={onboardingCopy.vaultSealedMessage} />
  {:else if data.notFound || !data.credential}
    <PageAlertBanner
      title="Credential not found"
      message="This credential does not exist or you do not have access."
      backHref={`/projects/${data.projectId}/credentials`}
      backLabel="Back to credentials"
    />
  {:else}
    <div class="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
      <p class="text-sm font-semibold uppercase tracking-wide text-slate-500">Credential</p>
      <h1 class="mt-2 text-3xl font-bold text-slate-950">{data.credential.name}</h1>
      {#if data.credential.description}
        <p class="mt-2 text-slate-600">{data.credential.description}</p>
      {/if}

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
                  href={resolve(
                    `/projects/${data.projectId}/credentials/${data.credentialId}/rotate`
                  )}
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
      {/if}

      <dl class="mt-5 grid gap-3 sm:grid-cols-2">
        <div class="rounded-2xl bg-slate-50 p-4">
          <dt class="text-sm text-slate-500">Tags</dt>
          <dd class="font-medium text-slate-950">
            {data.credential.tags.length > 0 ? data.credential.tags.join(', ') : '—'}
          </dd>
        </div>
        <div class="rounded-2xl bg-slate-50 p-4">
          <dt class="text-sm text-slate-500">Expires</dt>
          <dd class="font-medium text-slate-950">{formatDateTime(displayExpiresAt)}</dd>
        </div>
        <div class="rounded-2xl bg-slate-50 p-4">
          <dt class="text-sm text-slate-500">Current version</dt>
          <dd class="font-medium text-slate-950">{data.credential.currentVersionNumber}</dd>
        </div>
        <div class="rounded-2xl bg-slate-50 p-4">
          <dt class="text-sm text-slate-500">Updated</dt>
          <dd class="font-medium text-slate-950">{formatDateTime(data.credential.updatedAt)}</dd>
        </div>
      </dl>

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
              <FormHelpText id="lifecycle-expires-help" kind="date" />
            </div>
            <div class="space-y-1">
              <div class="flex items-center gap-2">
                <label
                  class="block text-sm font-medium text-slate-800"
                  for="lifecycle-rotation-schedule"
                >
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
              disabled={lifecycleSubmitting}
            >
              {lifecycleSubmitting ? 'Saving…' : 'Save lifecycle'}
            </button>
          </form>
        </div>
      {/if}
    </div>

    <section class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 class="text-lg font-semibold text-slate-950">Secret value</h2>
      {#if isMultiField && !editingFieldSet}
        <!-- Story 13.3 AC-1/2/3 — per-field interactive rows: non-sensitive fields show their
             value inline (from the eager `visibleFieldValues`, no click); sensitive fields show a
             masked placeholder plus their own "Reveal" button. Visible to anyone who can view the
             secret at all (viewer role) — only the Reveal/Reveal-all buttons themselves are
             gated by canReveal (member+), same as the legacy path below. -->
        <ul class="mt-3 space-y-1" data-testid="field-list">
          {#each fieldMeta as meta (meta.key)}
            {@const eagerValue = !meta.sensitive ? visibleFieldValues[meta.key] : undefined}
            {@const revealedFieldValue = revealedFields[meta.key]}
            <li
              class="flex items-center justify-between gap-3 rounded-lg bg-slate-50 px-3 py-2 text-sm"
              data-testid={`field-row-${meta.key}`}
            >
              <span class="font-medium text-slate-900">{meta.key}</span>
              <div class="flex items-center gap-2">
                {#if eagerValue !== undefined}
                  <span class="font-mono text-slate-700" data-testid={`field-value-${meta.key}`}
                    >{eagerValue}</span
                  >
                {:else if revealedFieldValue !== undefined}
                  <span class="font-mono text-slate-700" data-testid={`field-value-${meta.key}`}
                    >{revealedFieldValue}</span
                  >
                  {#if canReveal}
                    <button
                      class="rounded-lg border border-slate-300 px-2 py-1 text-xs font-medium"
                      type="button"
                      onclick={() => hideField(meta.key)}
                    >
                      Hide
                    </button>
                  {/if}
                {:else}
                  <span class="text-slate-400" data-testid={`field-masked-${meta.key}`}
                    >••••••••</span
                  >
                  {#if canReveal}
                    <button
                      class="rounded-lg border border-slate-300 px-2 py-1 text-xs font-medium disabled:opacity-60"
                      type="button"
                      disabled={revealingField === meta.key}
                      onclick={() => void revealSingleField(meta.key)}
                    >
                      {revealingField === meta.key ? 'Revealing…' : 'Reveal'}
                    </button>
                  {/if}
                {/if}
              </div>
            </li>
            {#if fieldRevealError[meta.key]}
              <p class="text-sm text-red-700" role="alert">{fieldRevealError[meta.key]}</p>
            {/if}
          {/each}
        </ul>
        {#if canReveal}
          <button
            class="mt-3 rounded-xl border border-slate-300 px-4 py-2 text-sm font-medium disabled:opacity-60"
            type="button"
            disabled={revealAllLoading}
            onclick={() => void revealAllFields()}
          >
            {revealAllLoading ? 'Revealing all…' : 'Reveal all'}
          </button>
          {#if revealAllError}
            <p class="mt-2 text-sm text-red-700" role="alert">{revealAllError}</p>
          {/if}
        {/if}
      {/if}
      {#if canReveal}
        {#if !isMultiField}
          <!-- AC-6: legacy/single-default-field secret — byte-for-byte unchanged single reveal
               button + <pre> block. -->
          {#if revealedValue === null}
            <button
              class="mt-4 rounded-xl bg-slate-950 px-4 py-3 text-sm font-semibold text-white disabled:opacity-60"
              type="button"
              disabled={revealing}
              onclick={() => void revealValue()}
            >
              {revealing ? 'Revealing…' : 'Reveal value'}
            </button>
          {:else}
            <pre
              class="mt-4 overflow-x-auto rounded-xl bg-slate-950 p-4 font-mono text-sm text-white">{revealedValue}</pre>
            <div class="mt-3 flex gap-3">
              <button
                class="rounded-xl border border-slate-300 px-4 py-2 text-sm font-medium"
                type="button"
                onclick={() => void copyValue()}
              >
                Copy
              </button>
              <button
                class="rounded-xl border border-slate-300 px-4 py-2 text-sm font-medium"
                type="button"
                onclick={() => {
                  revealedValue = null
                  revealVersion = null
                }}
              >
                Hide
              </button>
            </div>
            {#if copyStatus}
              <p
                class={`mt-2 text-sm ${copyStatus.kind === 'success' ? 'text-emerald-700' : 'text-red-700'}`}
                role="status"
              >
                {copyStatus.message}
              </p>
            {/if}
            {#if revealVersion !== null}
              <p class="mt-2 text-sm text-slate-600">Version {revealVersion}</p>
            {/if}
          {/if}
          {#if revealError}
            <p class="mt-3 text-sm text-red-700" role="alert">{revealError}</p>
          {/if}
        {/if}

        <div class="mt-6 border-t border-slate-200 pt-6">
          {#if isMultiField}
            <h3 class="font-semibold text-slate-950">Edit fields</h3>
            {#if !editingFieldSet}
              <button
                class="mt-3 rounded-xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white disabled:opacity-60"
                type="button"
                disabled={loadingFieldSet}
                onclick={() => void startEditFieldSet()}
              >
                {loadingFieldSet ? 'Loading…' : 'Edit fields'}
              </button>
            {:else}
              <form
                class="mt-3 space-y-3"
                onsubmit={(event) => {
                  event.preventDefault()
                  void saveFieldSet()
                }}
              >
                <FieldSetEditor
                  bind:fields={editFields}
                  errors={fieldSetErrors}
                  onAdd={addEditField}
                  onRemove={removeEditField}
                />
                {#if fieldSetFormError}
                  <p class="text-sm text-red-700" role="alert">{fieldSetFormError}</p>
                {/if}
                <div class="flex gap-2">
                  <button
                    class="rounded-xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
                    type="submit"
                    disabled={addingVersion}
                  >
                    {addingVersion ? 'Saving…' : 'Save fields'}
                  </button>
                  <button
                    class="rounded-xl border border-slate-300 px-4 py-2 text-sm font-medium"
                    type="button"
                    onclick={() => {
                      editingFieldSet = false
                      editFields = []
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            {/if}
          {:else}
            <h3 class="font-semibold text-slate-950">Add new version</h3>
            <form
              class="mt-3 space-y-3"
              onsubmit={(event) => {
                event.preventDefault()
                void onAddVersion()
              }}
            >
              <div class="space-y-1">
                <label class="block text-sm font-medium text-slate-800" for="new-version-value">
                  New value
                </label>
                <textarea
                  id="new-version-value"
                  class="w-full rounded-xl border border-slate-300 px-3 py-2 font-mono text-sm"
                  bind:value={newVersionValue}
                  aria-describedby="new-version-value-help"></textarea>
                <FormHelpText id="new-version-value-help" kind="secret" />
              </div>
              {#if addVersionError}
                <p class="text-sm text-red-700" role="alert">{addVersionError}</p>
              {/if}
              {#if addVersionBanner}
                <p class="text-sm text-red-700" role="alert">{addVersionBanner}</p>
              {/if}
              <button
                class="rounded-xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
                type="submit"
                disabled={addingVersion}
              >
                {addingVersion ? 'Adding…' : 'Add version'}
              </button>
            </form>
          {/if}
        </div>
      {:else}
        <p class="mt-3 text-sm text-slate-600">
          Revealing values requires Member access or higher.
        </p>
      {/if}
    </section>

    <section class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 class="text-lg font-semibold text-slate-950">Version history</h2>
      {#if data.versions.length === 0}
        <p class="mt-3 text-sm text-slate-600">No version history available.</p>
      {:else}
        <ul class="mt-4 space-y-2">
          {#each data.versions as version (version.versionNumber)}
            <li
              class="flex items-center justify-between rounded-xl border border-slate-200 px-4 py-3 text-sm"
            >
              <span class="font-medium">Version {version.versionNumber}</span>
              <span class="text-slate-600">{formatDateTime(version.createdAt)}</span>
              {#if version.isCurrent}
                <span
                  class="rounded-full bg-emerald-100 px-2 py-1 text-xs font-semibold text-emerald-800"
                >
                  Current
                </span>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <section class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 class="text-lg font-semibold text-slate-950">Dependent systems</h2>
      <FormHelpText id="dependent-systems-help" text={m.form_help_dependent_systems()} />
      {#if dependencyItems.length === 0}
        <p class="mt-3 text-sm text-slate-600">No dependent systems recorded.</p>
      {:else}
        {#if checklistError}
          <p class="mt-3 text-sm text-red-700" role="alert">{checklistError}</p>
        {/if}
        <ul class="mt-4 space-y-2">
          {#each dependencyItems as dependency (dependency.id)}
            {@const checklistItemStatus = dependency.checklistStatus?.status}
            {@const isFailed =
              checklistItemStatus === 'failed' || checklistItemStatus === 'max_retries_exceeded'}
            <li
              class="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 px-4 py-3 text-sm"
            >
              <div class="flex flex-wrap items-center gap-3">
                {#if isDependencyCheckboxRelevant(dependency)}
                  <!-- Story 18.7 AC-2/3: only rendered while there's a staged rotation this
                       dependency is actually tracked by — same conditional-render convention as
                       the "Scoped to"/link/failed badges below, so its appearance/disappearance
                       reads as ordinary row context rather than a jarring surprise control. -->
                  <label
                    class="flex items-center gap-2"
                    for={`dependency-updated-${dependency.id}`}
                  >
                    <input
                      id={`dependency-updated-${dependency.id}`}
                      type="checkbox"
                      checked={dependency.checklistStatus?.status === 'confirmed' || isFailed}
                      disabled={!canReveal ||
                        Boolean(confirmingDependencyId) ||
                        dependency.checklistStatus?.status === 'confirmed'}
                      onchange={() => void onConfirmDependencyUpdate(dependency)}
                      aria-describedby={`dependency-updated-help-${dependency.id}`}
                    />
                    <span class={isFailed ? 'font-medium text-amber-800' : undefined}>Updated</span>
                  </label>
                  <FormHelpText id={`dependency-updated-help-${dependency.id}`} kind="checkbox" />
                {/if}
                <span class="font-medium">{dependency.systemName} ({dependency.systemType})</span>
                {#if dependency.fieldKey}
                  <!-- Story 13.5 AC-6: scope badge, so Morgan-member can see at a glance which
                       rotations will include this dependency. -->
                  <span
                    class="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700"
                  >
                    Scoped to: {dependency.fieldKey}
                  </span>
                {/if}
                {#if dependency.linkUrl}
                  <!-- eslint-disable svelte/no-navigation-without-resolve -- AC-6.1: a
                       user-supplied external location link (validated http(s) server-side), not
                       a SvelteKit route resolve() can type-check. -->
                  <a
                    class="max-w-[16rem] truncate text-sm text-blue-700 underline"
                    href={dependency.linkUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={dependency.linkUrl}
                  >
                    {dependency.linkUrl}
                  </a>
                  <!-- eslint-enable svelte/no-navigation-without-resolve -->
                {/if}
                {#if isFailed}
                  <a
                    class="text-xs font-medium text-amber-800 underline"
                    href={resolve(
                      `/projects/${data.projectId}/credentials/${data.credentialId}/rotations/${dependency.checklistStatus?.rotationId}`
                    )}
                  >
                    {checklistItemStatus === 'max_retries_exceeded'
                      ? 'Retry limit reached — resolve on rotation page'
                      : 'Failed — resolve on rotation page'}
                  </a>
                {/if}
              </div>
              {#if canReveal}
                <button
                  class="text-sm font-medium text-red-700 underline disabled:cursor-not-allowed disabled:opacity-60"
                  type="button"
                  disabled={archivingDependencyId === dependency.id}
                  onclick={() => void onArchiveDependency(dependency.id)}
                >
                  {archivingDependencyId === dependency.id ? 'Archiving…' : 'Archive'}
                </button>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}

      {#if canReveal}
        <!-- Story 18.7 AC-5/6: collapsed by default behind a native <details>/<summary>
             disclosure — built-in keyboard operability (Enter/Space on the summary) and expanded
             state exposed to assistive tech for free, no bespoke bind:+ARIA needed. Open/closed
             state is plain client-side UI state (`dependencyFormOpen`, bound via `bind:open`) and
             intentionally does not persist across reloads (AC-6). -->
        <details class="mt-6 border-t border-slate-200 pt-6" bind:open={dependencyFormOpen}>
          <summary class="cursor-pointer font-semibold text-slate-950">
            Add dependent system
          </summary>
          <form
            class="mt-3 space-y-3"
            onsubmit={(event) => {
              event.preventDefault()
              void onAddDependency()
            }}
          >
            <div class="space-y-1">
              <label class="block text-sm font-medium text-slate-800" for="dependency-system-name">
                System name
              </label>
              <input
                id="dependency-system-name"
                class="w-full rounded-xl border border-slate-300 px-3 py-2"
                type="text"
                required
                bind:value={depSystemName}
                aria-describedby={`dependency-system-name-help${depNameError ? ' dependency-system-name-error' : ''}`}
                aria-invalid={depNameError ? 'true' : undefined}
              />
              <FormHelpText id="dependency-system-name-help" kind="text" />
              {#if depNameError}
                <p id="dependency-system-name-error" class="text-sm text-red-700" role="alert">
                  {depNameError}
                </p>
              {/if}
            </div>
            <div class="space-y-1">
              <label class="block text-sm font-medium text-slate-800" for="dependency-system-type">
                System type
              </label>
              <select
                id="dependency-system-type"
                class="w-full max-w-xs rounded-xl border border-slate-300 px-3 py-2"
                aria-describedby="dependency-system-type-help"
                bind:value={depSystemType}
              >
                <option value="service">Service</option>
                <option value="ci_pipeline">CI pipeline</option>
                <option value="database">Database</option>
                <option value="third_party">Third party</option>
                <option value="other">Other</option>
              </select>
              <FormHelpText
                id="dependency-system-type-help"
                text={m.form_help_dependency_system_type()}
              />
            </div>
            <div class="space-y-1">
              <label class="block text-sm font-medium text-slate-800" for="dependency-notes">
                Notes
              </label>
              <textarea
                id="dependency-notes"
                class="w-full rounded-xl border border-slate-300 px-3 py-2"
                bind:value={depNotes}
                aria-describedby="dependency-notes-help"></textarea>
              <FormHelpText id="dependency-notes-help" kind="text" />
            </div>
            {#if fieldMeta.length > 1}
              <!-- Story 13.5 AC-6: only rendered for multi-field credentials — hidden entirely
                   for single-field/legacy credentials (matches the rotation field-selector's own
                   field_meta.length > 1 gating convention, Story 13.4). -->
              <div class="space-y-1">
                <label class="block text-sm font-medium text-slate-800" for="dependency-field-key">
                  Scope to field
                </label>
                <select
                  id="dependency-field-key"
                  class="w-full max-w-xs rounded-xl border border-slate-300 px-3 py-2"
                  aria-describedby="dependency-field-key-help"
                  bind:value={depFieldKey}
                >
                  <option value="">Whole credential</option>
                  {#each fieldMeta as field (field.key)}
                    <option value={field.key}>{field.key}</option>
                  {/each}
                </select>
                <FormHelpText
                  id="dependency-field-key-help"
                  text={m.form_help_dependency_scope()}
                />
              </div>
            {/if}
            <div class="space-y-1">
              <label class="block text-sm font-medium text-slate-800" for="dependency-link-url">
                Link (optional)
              </label>
              <input
                id="dependency-link-url"
                class="w-full rounded-xl border border-slate-300 px-3 py-2"
                type="url"
                placeholder="https://…"
                aria-describedby="dependency-link-url-help dependency-link-url-security-note"
                bind:value={depLinkUrl}
              />
              <FormHelpText id="dependency-link-url-help" text={m.form_help_dependency_link()} />
              <p id="dependency-link-url-security-note" class="text-xs text-slate-500">
                This link is visible to everyone with view access to this credential and is stored
                in plaintext audit logs.
              </p>
            </div>
            {#if depError}
              <p class="text-sm text-red-700" role="alert">{depError}</p>
            {/if}
            {#if depBanner}
              <p class="text-sm text-red-700" role="alert">{depBanner}</p>
            {/if}
            <button
              class="rounded-xl bg-slate-950 px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
              type="submit"
              disabled={depSubmitting}
            >
              {depSubmitting ? 'Adding…' : 'Add dependent system'}
            </button>
          </form>
        </details>
      {/if}
    </section>

    <section class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 class="text-lg font-semibold text-slate-950">Rotation</h2>

      {#if data.activeRotationId}
        <a
          class="mt-4 inline-block rounded-xl bg-slate-950 px-4 py-3 text-sm font-semibold text-white"
          href={resolve(
            `/projects/${data.projectId}/credentials/${data.credentialId}/rotations/${data.activeRotationId}`
          )}
        >
          View active rotation
        </a>
      {:else if canManageRotation}
        <a
          class="mt-4 inline-block rounded-xl bg-slate-950 px-4 py-3 text-sm font-semibold text-white"
          href={resolve(`/projects/${data.projectId}/credentials/${data.credentialId}/rotate`)}
        >
          Start rotation
        </a>
      {:else}
        <p class="mt-3 text-sm text-slate-600">{rotationCopy.startRotationRequiresAdmin}</p>
      {/if}

      <h3 class="mt-6 font-semibold text-slate-950">History</h3>
      {#if data.rotations.length === 0}
        <p class="mt-3 text-sm text-slate-600">{rotationCopy.noRotationsYet}</p>
      {:else}
        <ul class="mt-4 space-y-2">
          {#each data.rotations as rotation (rotation.id)}
            <li
              class="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 px-4 py-3 text-sm"
            >
              <a
                class="font-medium text-slate-950 underline"
                href={resolve(
                  `/projects/${data.projectId}/credentials/${data.credentialId}/rotations/${rotation.id}`
                )}
              >
                initiated {formatDateTime(rotation.initiatedAt)}
              </a>
              <span class={rotationStatusBadgeClass(rotation.status)}>{rotation.status}</span>
              <span class="text-slate-600">completed {formatDateTime(rotation.completedAt)}</span>
              <span class="text-slate-600">
                {rotation.confirmedCount}/{rotation.itemCount} confirmed
              </span>
            </li>
          {/each}
        </ul>
        {#if data.rotationsHasMore}
          <a
            class="mt-3 inline-block text-sm font-medium text-slate-700 underline"
            href={resolve(
              `/projects/${data.projectId}/credentials/${data.credentialId}?page=${data.rotationsPage + 1}`
            )}
          >
            Show more
          </a>
        {/if}
      {/if}
    </section>

    <section class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <h2 class="text-lg font-semibold text-slate-950">Shares</h2>
      <p class="mt-1 text-sm text-slate-600">
        Share this credential's current value with another organization member via a bounded-
        duration link. They'll be notified in-app.
      </p>

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
              data.origin,
              lastCreatedShareIsExternal
                ? `/external-shares/${lastCreatedShareToken}`
                : `/shares/${lastCreatedShareToken}`
            )}
          </code>
          {#if lastCreatedShareIsExternal}
            <p class="mt-2 text-xs text-amber-900">
              No in-app notification is sent to the recipient — send them this link yourself. Org
              admins have been notified a new external share was created.
            </p>
          {/if}
        </div>
      {/if}

      {#if data.orgRole !== 'viewer'}
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
              max={shareRecipientType === 'external'
                ? EXTERNAL_SHARE_MAX_HOURS
                : MEMBER_SHARE_MAX_HOURS}
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
            <p class="mt-6 text-sm text-slate-500">
              Single view only (always on for external shares)
            </p>
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
            value={data.sharesStatus ?? ''}
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
        <p class="mt-3 text-sm text-slate-600">No shares yet for this credential.</p>
      {:else}
        <p class="mt-2 text-xs text-slate-500">
          Showing {shareItems.length} of {data.sharesTotal ?? shareItems.length}
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
                  {shareableOrgMembers.find((m) => m.userId === share.recipientUserId)
                    ?.displayName ??
                    shareableOrgMembers.find((m) => m.userId === share.recipientUserId)?.email ??
                    'org member'}
                {/if}
              </span>
              <span class="text-slate-600">created {formatDateTime(share.createdAt)}</span>
              <span class="text-slate-600">expires {formatDateTime(share.expiresAt)}</span>
              <span class="text-slate-600">
                {share.firstViewedAt
                  ? `viewed ${formatDateTime(share.firstViewedAt)}`
                  : 'not viewed'}
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
          {#if (data.sharesPage ?? 1) > 1}
            <a
              class="text-sm font-medium text-slate-700 underline"
              href={resolve(
                `/projects/${data.projectId}/credentials/${data.credentialId}?${sharesPageQuery((data.sharesPage ?? 1) - 1)}`
              )}
            >
              Previous
            </a>
          {/if}
          {#if (data.sharesPage ?? 1) * 25 < (data.sharesTotal ?? 0)}
            <a
              class="text-sm font-medium text-slate-700 underline"
              href={resolve(
                `/projects/${data.projectId}/credentials/${data.credentialId}?${sharesPageQuery((data.sharesPage ?? 1) + 1)}`
              )}
            >
              Next
            </a>
          {/if}
        </div>
      {/if}
    </section>

    <a
      class="inline-block font-medium text-slate-700 underline"
      href={resolve(`/projects/${data.projectId}/credentials`)}
    >
      Back to credentials
    </a>
  {/if}
</section>
