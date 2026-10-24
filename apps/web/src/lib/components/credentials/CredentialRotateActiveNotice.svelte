<script lang="ts">
  import { resolve } from '$app/paths'

  // Story 69.14: the pre-emptive "a rotation is already in progress" banner of the start-rotation
  // page (Story 13.4 AC-6), shown before a submit that would only 409.
  let {
    projectId,
    credentialId,
    activeRotationId,
  }: { projectId: string; credentialId: string; activeRotationId: string | null } = $props()
</script>

<p class="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900" role="alert">
  A rotation is already in progress for this secret.
  <a
    class="ml-1 font-medium underline"
    href={resolve(
      `/projects/${projectId}/credentials/${credentialId}/rotations/${activeRotationId}`
    )}
  >
    View active rotation
  </a>
</p>
