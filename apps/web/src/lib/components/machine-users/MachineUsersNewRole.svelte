<script lang="ts">
  import InjectionPoint from '$lib/components/composition/InjectionPoint.svelte'
  import type { MachineUserRole } from '@project-vault/shared'
  import FormHelpText from '$lib/components/forms/FormHelpText.svelte'
  import { m } from '$lib/paraglide/messages.js'

  // Story 69.12: the role select of the new machine user form. The form owns the value (bindable).
  let {
    role = $bindable(),
    data,
  }: {
    role: MachineUserRole
    data?: Record<string, readonly unknown[]> | undefined
  } = $props()
</script>

<!-- @region project.machine-users-new.role -->
<div class="space-y-2">
  <label class="block font-medium text-slate-900" for="machine-user-role">Role</label>
  <select
    id="machine-user-role"
    class="w-full rounded-xl border border-[color:var(--color-border-strong,#64748b)] px-3 py-3"
    aria-describedby="machine-user-role-help"
    bind:value={role}
  >
    <option value="member">Member — can read/write project secrets</option>
    <option value="viewer">Viewer — read-only project secrets</option>
  </select>
  <FormHelpText id="machine-user-role-help" text={m.form_help_machine_user_role()} /><InjectionPoint
    name="project.machine-users-new.role"
    {data}
  />
</div>
