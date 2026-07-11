<script lang="ts">
  import AuthBrandHeader from '$lib/components/shell/AuthBrandHeader.svelte'
  import Footer from '$lib/components/shell/Footer.svelte'

  let { children } = $props()
</script>

<main class="min-h-screen bg-slate-50 px-4 py-10 text-slate-950">
  <section class="mx-auto max-w-xl rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
    <AuthBrandHeader />
    {@render children()}
  </section>
  <div class="mx-auto mt-6 max-w-xl">
    <Footer />
  </div>
</main>
