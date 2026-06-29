<script lang="ts">
  import AppShell from '$lib/components/shell/AppShell.svelte'
  import OnboardingWizard from '$lib/components/onboarding/OnboardingWizard.svelte'

  let { data, children } = $props()
  // Client-side flag optimizes rendering; +layout.server.ts remains authoritative on full loads.
  let onboardingDone = $state(data.onboardingCompleted)
</script>

<AppShell user={data.user} hidePrimaryNav={!onboardingDone}>
  {#if !onboardingDone}
    <OnboardingWizard
      user={data.user}
      projects={data.projects}
      oncompleted={() => {
        onboardingDone = true
      }}
    />
  {:else}
    {@render children()}
  {/if}
</AppShell>
