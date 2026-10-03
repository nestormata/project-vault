<script lang="ts">
  import Footer from '$lib/components/shell/Footer.svelte'

  let { children }: { children: import('svelte').Snippet } = $props()
</script>

<!-- M1 (c): a layout override for the whole (auth) group. -->
<main data-testid="mock-auth-layout" data-mock-ui-pack="m1-auth-layout">
  <p>mock-ui-pack:m1-auth-layout</p>
  {@render children()}
  <Footer />
</main>
