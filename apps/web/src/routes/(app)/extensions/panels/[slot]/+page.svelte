<script lang="ts">
  let { data } = $props()
</script>

<svelte:head>
  <title>Extension | Project Vault</title>
</svelte:head>

<div class="mx-auto max-w-3xl px-4 py-8">
  <h1 class="text-2xl font-bold text-gray-900">Extension</h1>

  {#if data.html !== null}
    <!--
      Story 25.1 AC4 — SECURITY: `allow-same-origin` must NEVER be added to this sandbox token
      set. `srcdoc` content inherits the *embedding page's own origin*, not a neutral/opaque one
      — `allow-scripts` alone keeps the sandboxed document's origin forced-opaque (unique,
      unrelated to PV's), so a bug in the panel's returned HTML cannot read PV's own
      cookies/localStorage/DOM. Adding `allow-same-origin` on top of `allow-scripts` for `srcdoc`
      content is a well-documented escape class (the two combined let sandboxed script access the
      parent document's real origin) — this is not hypothetical, it is the single most important
      token-choice constraint in this story. A future PR "helpfully" adding `allow-same-origin` to
      fix a panel-compatibility complaint would silently reopen this exact hole.

      Known accepted limitation (Story 25.1 Dev Notes, scoped to Story 25.4): `allow-scripts`
      alone does not stop the panel's script from making outbound fetch/XHR to third-party
      endpoints or loading additional remote content — there is no Content-Security-Policy yet
      (Story 25.4's explicit scope). The loaded extension is already trusted/in-process by this
      project's current security model, so this is a bounded, already-accepted extension of that
      same trust boundary to the extension's panel output specifically — not a new risk category
      this story introduces, but not a complete network/resource-loading boundary either.
    -->
    <div class="mt-6 overflow-hidden rounded-2xl border border-slate-200">
      <iframe
        title="Extension panel"
        sandbox="allow-scripts"
        srcdoc={data.html}
        class="h-[70vh] w-full border-0"
      ></iframe>
    </div>
  {:else}
    <!-- AC3: the same calm placeholder for every degraded cause — throw, timeout, malformed
         result, or the extension/hook simply being gone by request time. -->
    <div class="mt-8 rounded-2xl border border-slate-200 bg-slate-50 p-6">
      <p class="text-slate-600">This panel is temporarily unavailable.</p>
    </div>
  {/if}
</div>
