<script lang="ts">
  import AppShell from '$lib/components/shell/AppShell.svelte'
  import GlobalSearch from '$lib/components/shell/GlobalSearch.svelte'
  import OnboardingWizard from '$lib/components/onboarding/OnboardingWizard.svelte'

  let { data, children } = $props()
  let onboardingDone = $state(data.onboardingCompleted)
  let searchOpen = $state(false)
</script>

<GlobalSearch bind:open={searchOpen} />

<AppShell
  user={data.user}
  hidePrimaryNav={!onboardingDone}
  onsearch={() => {
    searchOpen = true
  }}
>
  {#if !onboardingDone}
    <OnboardingWizard
      user={data.user}
      projects={data.projects}
      importRouteLive={data.importRouteLive}
      oncompleted={() => {
        onboardingDone = true
      }}
    />
  {:else}
    {@render children()}
  {/if}
</AppShell>
