<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import type { CredentialDetail } from '@project-vault/shared'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import type { CredentialPointExtras } from '$lib/credentials/credential-detail-helpers.js'
  import CredentialValueAddVersion from './CredentialValueAddVersion.svelte'
  import CredentialValueCopyStatus from './CredentialValueCopyStatus.svelte'
  import { CredentialValueController } from './credential-value-controller.svelte.js'
  import CredentialValueEditFields from './CredentialValueEditFields.svelte'
  import CredentialValueFields from './CredentialValueFields.svelte'
  import CredentialValueSingle from './CredentialValueSingle.svelte'

  // Story 69.2: the Secret value section (reveal, per-field reveal, copy without reveal, add version,
  // field-set editor) as one replaceable region. Story 69-14: its sections are sub-regions that share
  // ONE state owner, the controller created here. Everything display-once (the revealed value, the
  // revealed fields, the editor's pre-filled values) lives in the controller: it is never a prop of
  // a point, never in `data`, never in a store or the URL.
  let {
    credential,
    projectId,
    credentialId,
    orgRole,
    project,
    pointProps,
    data,
  }: {
    credential: CredentialDetail
    projectId: string
    credentialId: string
    orgRole: CredentialPointExtras['orgRole']
    project: CredentialPointExtras['project']
    pointProps: CredentialPointExtras
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()

  const controller = new CredentialValueController(() => ({
    credential,
    projectId,
    credentialId,
    orgRole,
    project,
  }))

  onMount(() => controller.mount())
  onDestroy(() => controller.destroy())
</script>

<!-- @region credential.detail.value -->
<section class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
  <h2 class="text-lg font-semibold text-slate-950">Secret value</h2>
  {#if controller.isMultiField && !controller.editingFieldSet}
    <CredentialValueFields {controller} {pointProps} {data} />
  {/if}
  {#if controller.canReveal}
    {#if !controller.isMultiField}
      <CredentialValueSingle {controller} {pointProps} {data} />
    {/if}

    <CredentialValueCopyStatus {controller} {pointProps} {data} />

    <div class="mt-6 border-t border-slate-200 pt-6">
      {#if controller.isMultiField}
        <CredentialValueEditFields {controller} {pointProps} {data} />
      {:else}
        <CredentialValueAddVersion {controller} {pointProps} {data} />
      {/if}
    </div>
  {:else}
    <p class="mt-3 text-sm text-slate-600">Revealing values requires Member access or higher.</p>
  {/if}<InjectionPoint name="credential.detail.value" props={pointProps} {data} />
</section>
