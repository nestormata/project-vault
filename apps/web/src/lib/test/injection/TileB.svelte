<script lang="ts">
  let { data = null }: { data?: unknown } = $props()
</script>

<p id="b">B {JSON.stringify(data)}</p>
