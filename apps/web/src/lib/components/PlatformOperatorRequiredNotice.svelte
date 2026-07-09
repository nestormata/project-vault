<script lang="ts">
  import { resolve } from '$app/paths'
</script>

<div class="mx-auto max-w-3xl px-4 py-16 text-center">
  <h1 class="text-2xl font-bold text-gray-900">Platform Operator Access Required</h1>
  <p class="mt-4 text-gray-500">
    This page is restricted to platform operators. Your account does not have platform operator
    privileges.
  </p>
  <a
    href={resolve('/dashboard')}
    class="mt-8 inline-block rounded-xl border border-slate-300 px-4 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50"
  >
    ← Back to Dashboard
  </a>
</div>
