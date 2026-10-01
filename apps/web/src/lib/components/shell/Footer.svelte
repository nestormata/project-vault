<script lang="ts">
  // Story 68.1 AC-7: no props or logic; the TypeScript script block lets svelte-check type this
  // component and its importers (a script-less component has no type declaration).
</script>

<footer
  class="flex flex-col items-center justify-center gap-2 px-4 py-4 text-sm text-slate-500 sm:flex-row sm:gap-4"
>
  <p>© {new Date().getFullYear()} Project Vault</p>
  <a
    href="https://github.com/nestormata/project-vault"
    target="_blank"
    rel="noopener noreferrer"
    class="text-brand-600 hover:text-brand-700"
  >
    GitHub
  </a>
  <a
    href="https://github.com/nestormata/project-vault/blob/main/LICENSE"
    target="_blank"
    rel="noopener noreferrer"
    class="text-brand-600 hover:text-brand-700"
  >
    AGPL-3.0
  </a>
</footer>
