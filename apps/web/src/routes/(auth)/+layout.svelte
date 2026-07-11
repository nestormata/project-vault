<script lang="ts">
  import { resolve } from '$app/paths'

  let { children } = $props()
</script>

<main class="min-h-screen bg-slate-50 px-4 py-10 text-slate-950">
  <section class="mx-auto max-w-xl rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
    <div class="mb-8 space-y-2">
      <div class="flex items-center gap-2">
        <img src={resolve('/logo.png')} alt="" width="238" height="240" class="h-8 w-auto" />
        <p class="text-sm font-semibold uppercase tracking-wide text-slate-500">Project Vault</p>
      </div>
      <p class="text-slate-600">Run complex projects. Miss nothing.</p>
    </div>
    {@render children()}
  </section>
</main>
