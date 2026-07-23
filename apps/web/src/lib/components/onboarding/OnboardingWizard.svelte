<script lang="ts">
  import type { ProjectSummary } from '@project-vault/shared'
  import type { AuthUser } from '$lib/api/auth.js'
  import { completeOnboarding } from '$lib/api/onboarding.js'
  import OnboardingDialog from './OnboardingDialog.svelte'
  import OnboardingStep1 from './OnboardingStep1.svelte'
  import OnboardingStep2 from './OnboardingStep2.svelte'
  import OnboardingStep3 from './OnboardingStep3.svelte'
  import { canCreateCredential } from './onboarding-logic.js'

  // Step state is intentionally in-memory only — no URL changes during the wizard.
  // A refresh resets to step 1; committed data (credential, onboarding row) persists server-side.

  let {
    user,
    projects,
    importRouteLive = false,
    oncompleted,
  }: {
    user: AuthUser
    projects: ProjectSummary[]
    importRouteLive?: boolean
    oncompleted: () => void
  } = $props()

  let step = $state(1)
  let projectId = $state<string | null>(null)
  let dialogRef = $state<HTMLElement | null>(null)
  const headingId = 'onboarding-step-heading'

  $effect(() => {
    if (projectId === null) {
      projectId = projects[0]?.id ?? null
    }
  })

  function focusHeading() {
    queueMicrotask(() => {
      dialogRef?.querySelector<HTMLElement>(`#${headingId}`)?.focus()
    })
  }

  function goToStep(next: number) {
    step = next
    focusHeading()
  }

  async function dismissWizard() {
    try {
      await completeOnboarding(fetch)
    } catch {
      // Fail-open dismissal still closes the overlay for blocked viewer paths.
    }
    oncompleted()
  }
</script>

<OnboardingDialog bind:dialogRef labelledby={headingId} onClose={() => void dismissWizard()}>
  {#if step === 1}
    <OnboardingStep1
      orgName={user.orgId}
      orgRole={user.orgRole}
      hasProject={projectId !== null}
      {headingId}
      onProjectReady={(id) => {
        projectId = id
        focusHeading()
      }}
      onContinue={() => goToStep(2)}
      onDismiss={() => void dismissWizard()}
    />
  {:else if step === 2}
    {#if projectId}
      <OnboardingStep2
        orgRole={user.orgRole}
        {projectId}
        {headingId}
        onCredentialCreated={() => goToStep(3)}
        onViewerContinue={() => void dismissWizard()}
      />
    {:else if !canCreateCredential(user.orgRole)}
      <OnboardingStep1
        orgName={user.orgId}
        orgRole={user.orgRole}
        hasProject={false}
        {headingId}
        onProjectReady={() => {}}
        onContinue={() => {}}
        onDismiss={() => void dismissWizard()}
      />
    {/if}
  {:else}
    <OnboardingStep3 {projectId} {headingId} {importRouteLive} {oncompleted} />
  {/if}
</OnboardingDialog>
