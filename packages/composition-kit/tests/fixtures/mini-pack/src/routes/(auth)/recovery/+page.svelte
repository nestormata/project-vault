<script lang="ts">
  import { formatPlan } from '$lib/cm-format.js'
</script>

<h1 data-testid="cm-recovery" class="bg-[#123456] text-cm-accent">
  Acme recovery. {formatPlan('recovery')}
</h1>
