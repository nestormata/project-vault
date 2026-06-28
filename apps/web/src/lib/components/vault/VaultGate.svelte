<script>
  import VaultInitForm from './VaultInitForm.svelte'
  import VaultUnsealForm from './VaultUnsealForm.svelte'
  import { getVaultGateModel } from './gate-model.js'

  let { readiness, onRetry, onInit, onUnseal } = $props()
  let model = $derived(getVaultGateModel(readiness))
</script>

{#snippet gateCopy()}
  <div class="space-y-2">
    <p class="text-sm font-semibold uppercase tracking-wide text-slate-500">{model.eyebrow}</p>
    <h1 class="text-3xl font-bold text-slate-950">{model.title}</h1>
    <p class="text-slate-600">{model.message}</p>
  </div>
{/snippet}

<section
  class="mx-auto flex max-w-3xl flex-col gap-6 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm"
>
  {#if model.showInit}
    {@render gateCopy()}
    <VaultInitForm onSubmit={onInit} />
  {:else if model.showUnseal}
    {@render gateCopy()}
    <VaultUnsealForm onSubmit={onUnseal} />
  {:else if model.primaryAction === 'Retry readiness'}
    <div class="space-y-4">
      {@render gateCopy()}
      <button
        class="w-fit rounded-xl bg-slate-950 px-4 py-2 font-semibold text-white"
        type="button"
        onclick={onRetry}
      >
        {model.primaryAction}
      </button>
    </div>
  {:else}
    {@render gateCopy()}
  {/if}
</section>
