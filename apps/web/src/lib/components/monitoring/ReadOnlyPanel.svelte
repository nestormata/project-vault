<!--
  AC-I1/code-review finding: a viewer must not see a disabled-but-visible mutation form (which
  invites a stale-role 403 on click) — the certificates/domains/services/service-endpoints detail
  pages show this plain read-only panel of ReadOnlyField rows instead, in the `canManage` branch's
  `{:else}`.
-->
<script lang="ts">
  let { children }: { children: import('svelte').Snippet } = $props()
</script>

<div class="space-y-4 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
  {@render children()}
</div>
