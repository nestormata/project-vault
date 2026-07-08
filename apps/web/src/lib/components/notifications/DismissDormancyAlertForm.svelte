<!--
  Shared "type a reason, dismiss" form for a dormancy alert (`security_alerts` row), reused
  identically by the machine-key and user dormancy sections on /notifications (Story 8.7 extends
  8.6's machine-key section with a sibling user-dormancy section using the exact same dismiss
  action/shape) — both post to the same generic `?/dismissDormancyAlert` action.
-->
<script lang="ts">
  import { enhance } from '$app/forms'

  let { alertId }: { alertId: string } = $props()
</script>

<form method="POST" action="?/dismissDormancyAlert" use:enhance class="flex items-center gap-2">
  <input type="hidden" name="alertId" value={alertId} />
  <input
    type="text"
    name="reason"
    required
    placeholder="Reason for dismissing"
    class="rounded border border-gray-300 px-2 py-1 text-xs"
  />
  <button type="submit" class="text-xs font-medium text-gray-600 hover:text-gray-800">
    Dismiss
  </button>
</form>
