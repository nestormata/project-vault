<script lang="ts">
  // PV's own specifier for a module the pack replaced, imported by client code: the replacement
  // lives under src/lib/server/_cm, so Kit's guard must still reject it.
  import { requireUser } from '$lib/server/require-user.js'

  const user = requireUser({ user: null })
</script>

<p>{user.orgName}</p>
