<!--
  Story 72.6 (P3a): the skip link, the first tab stop of the app shell. Off-screen until it takes
  focus; it targets the shell's `<main id="main-content">`. The target id is a prop so a composed
  app that moves the main region can point it elsewhere.
-->
<script lang="ts">
  import { m } from '$lib/paraglide/messages.js'

  let { target = 'main-content' }: { target?: string } = $props()
</script>

<a
  href={`#${target}`}
  class="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-xl focus:bg-white focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-slate-900 focus:shadow-lg focus:ring-2 focus:ring-brand-600"
  data-testid="skip-link">{m.shell_skip_to_content()}</a
>
