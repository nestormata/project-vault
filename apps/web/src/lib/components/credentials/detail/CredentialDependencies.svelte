<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import type { CredentialDetail } from '@project-vault/shared'
  import type { CredentialDependencyWithChecklistStatus } from '$lib/api/credentials.js'
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'
  import type { CredentialPointExtras } from '$lib/credentials/credential-detail-helpers.js'
  import { m } from '$lib/paraglide/messages.js'
  import CredentialDependenciesAdd from './CredentialDependenciesAdd.svelte'
  import { CredentialDependenciesController } from './credential-dependencies-controller.svelte.js'
  import CredentialDependenciesList from './CredentialDependenciesList.svelte'

  // Story 69.2: the Dependent systems section (list, checklist confirm, add form, the 15 s
  // visibility-aware poll) as one replaceable region. Story 69-14: its list and add form are
  // sub-regions that share ONE state owner, the controller created here. The poll and its
  // visibility listener start and stop with this component, so nothing outlives it.
  let {
    credential,
    projectId,
    credentialId,
    orgRole,
    project,
    dependencies,
    pointProps,
    data,
  }: {
    credential: CredentialDetail
    projectId: string
    credentialId: string
    orgRole: CredentialPointExtras['orgRole']
    project: CredentialPointExtras['project']
    dependencies: {
      items: CredentialDependencyWithChecklistStatus[]
      hasDependencies: boolean
      hasStagedRotation: boolean
    }
    pointProps: CredentialPointExtras
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()

  const controller = new CredentialDependenciesController(() => ({
    credential,
    projectId,
    credentialId,
    orgRole,
    project,
    dependencies,
  }))

  $effect(() => {
    controller.schedulePoll()
  })
  onMount(() => controller.mount())
  onDestroy(() => controller.destroy())
</script>

<!-- @region credential.detail.dependencies -->
<section class="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
  <h2 class="text-lg font-semibold text-slate-950">Dependent systems</h2>
  <FormHelpText id="dependent-systems-help" text={m.form_help_dependent_systems()} />
  <CredentialDependenciesList {controller} {pointProps} {data} />

  {#if controller.canReveal}
    <CredentialDependenciesAdd {controller} {pointProps} {data} />
  {/if}<InjectionPoint name="credential.detail.dependencies" props={pointProps} {data} />
</section>
