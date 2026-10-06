<script lang="ts">
  import type { ComponentProps, Snippet } from 'svelte'
  import RegisterForm from './RegisterForm.svelte'

  // Story 69.6: the registration form as one replaceable region; `children` is the region's
  // injection point, rendered right after the form.
  let { children, ...form }: ComponentProps<typeof RegisterForm> & { children?: Snippet } = $props()
</script>

<RegisterForm {...form} />{@render children?.()}
