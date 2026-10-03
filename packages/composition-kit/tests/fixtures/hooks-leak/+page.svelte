<script lang="ts">
  // Story 68-6 AC-1 negative fixture: a client component importing the SERVER hooks virtual module.
  // The module re-exports server-only CM code under src/lib/server/_cm, so Kit's own server-only
  // guard must fail the build.
  import { hooks } from 'virtual:pv-hooks/server'

  const names = Object.keys(hooks)
</script>

<p>{names.length}</p>
