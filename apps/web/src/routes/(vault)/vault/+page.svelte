<script>
  import { goto } from '$app/navigation'
  import { resolve } from '$app/paths'
  import AuthBrandHeader from '$lib/components/shell/AuthBrandHeader.svelte'
  import VaultGate from '$lib/components/vault/VaultGate.svelte'
  import { getVaultReadiness, initVault, unsealVault } from '$lib/api/vault.js'

  let { data } = $props()
  let readiness = $state(null)

  async function refreshReadiness() {
    readiness = await getVaultReadiness(fetch)
    if (readiness.state === 'ready') await goto(resolve('/login'))
  }

  async function handleInit(request, bootstrapToken) {
    await initVault(fetch, request, bootstrapToken)
    await refreshReadiness()
  }

  async function handleUnseal(request) {
    await unsealVault(fetch, request)
    await refreshReadiness()
  }
</script>

<svelte:head>
  <title>Vault readiness | Project Vault</title>
</svelte:head>

<main class="min-h-screen bg-slate-50 px-4 py-10 text-slate-950">
  <div class="mx-auto max-w-3xl">
    <AuthBrandHeader />
  </div>
  <VaultGate
    readiness={readiness ?? data.readiness}
    onRetry={refreshReadiness}
    onInit={handleInit}
    onUnseal={handleUnseal}
  />
</main>
