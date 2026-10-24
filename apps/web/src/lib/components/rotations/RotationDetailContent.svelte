<script lang="ts">
  import type { PageData } from '../../../routes/(app)/projects/[projectId]/credentials/[credentialId]/rotations/[rotationId]/$types.js'
  import type { Snippet } from 'svelte'
  import { onDestroy, onMount } from 'svelte'
  import { rotationCopy } from '$lib/components/rotations/rotation-copy.js'
  import NavLink from '$lib/navigation/NavLink.svelte'
  import StaleRecoveryBanner from '$lib/components/rotations/StaleRecoveryBanner.svelte'
  import RotationAbandon from './RotationAbandon.svelte'
  import RotationChecklist from './RotationChecklist.svelte'
  import RotationComplete from './RotationComplete.svelte'
  import { RotationController } from './rotation-controller.svelte.js'
  import RotationNote from './RotationNote.svelte'
  import RotationPromote from './RotationPromote.svelte'
  import RotationRetire from './RotationRetire.svelte'
  import RotationStagedValue from './RotationStagedValue.svelte'
  import RotationSummary from './RotationSummary.svelte'
  import RotationTerminalNote from './RotationTerminalNote.svelte'
  import RotationUnavailable from './RotationUnavailable.svelte'

  // Story 69.14: the gate plus the sections of the rotation detail page. This component owns the
  // page state (one controller: working copy, polling, banners, actions); the page hands over its
  // loader data as `pageData` and its `__inject` map as `data`.
  let {
    pageData,
    data,
    children,
  }: {
    pageData: PageData
    data?: Record<string, readonly unknown[]> | undefined
    children?: Snippet
  } = $props()

  const controller = new RotationController(() => pageData)
  const rotation = $derived(controller.rotation)

  $effect(() => {
    controller.syncPolling()
  })
  onMount(() => {
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', controller.handleVisibilityChange)
    }
  })
  onDestroy(() => {
    controller.clearPoll()
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', controller.handleVisibilityChange)
    }
  })
</script>

<section class="mx-auto max-w-3xl space-y-6">
  {#if pageData.vaultSealed || pageData.notFound || !rotation}
    <RotationUnavailable
      sealed={pageData.vaultSealed ?? false}
      projectId={pageData.projectId}
      credentialId={pageData.credentialId}
    />
  {:else}
    <RotationSummary {controller} {rotation} {data} />
    {#if !controller.canAct}
      <RotationNote tone="slate" text={rotationCopy.checklistActionsRequireMember} />
    {/if}
    {#if rotation.status === 'stale_recovery' && controller.canManage}
      <StaleRecoveryBanner
        projectId={controller.projectId}
        credentialId={controller.credentialId}
        rotationId={controller.rotationId}
        onResumed={controller.handleResumed}
        onAbandoned={controller.handleAbandoned}
        onConcurrentModification={controller.handleConcurrentModification}
      />
    {/if}
    {#if rotation.status === 'staged' || rotation.status === 'promoted'}
      <RotationNote tone="sky" role="note" text={rotationCopy.checklistIsAdvisory} />
    {/if}
    {#if rotation.status === 'staged' && controller.canAct}
      <RotationStagedValue {controller} {data} />
    {/if}
    <RotationChecklist {controller} {rotation} {data} />
    {#if rotation.status === 'in_progress' && controller.canManage}
      <RotationComplete {controller} {data} />
    {/if}
    {#if rotation.status === 'staged' && controller.canManage}
      <RotationPromote {controller} {data} />
      <RotationAbandon {controller} {data} />
    {/if}
    {#if rotation.status === 'promoted' && controller.canManage}
      <RotationRetire {controller} {data} />
    {/if}
    {#if rotation.status === 'retired' || rotation.status === 'abandoned'}
      <RotationTerminalNote status={rotation.status} />
    {/if}
    <NavLink
      surface="back"
      node="back.project.rotation"
      class="inline-block font-medium text-slate-700 underline"
      projectId={controller.projectId}
      credentialId={controller.credentialId}
    />
  {/if}
</section>
{@render children?.()}
