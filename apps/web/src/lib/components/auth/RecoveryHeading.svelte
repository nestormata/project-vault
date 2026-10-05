<script lang="ts">
  import type { Snippet } from 'svelte'

  let { children }: { children?: Snippet } = $props()
</script>

<div class="space-y-2">
  <h1 class="text-3xl font-bold">Recover your account</h1>
  <p class="text-slate-600">Enter your email and we'll send you a link to reset your password.</p>
</div>
{@render children?.()}
