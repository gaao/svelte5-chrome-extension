<script>
  import Self from './Nested.svelte';

  let { depth = 0 } = $props();
  const max = 3;
</script>

<div class="nested" style="margin-left: {depth * 8}px">
  <span>depth {depth}</span>
  {#if depth < max}
    <Self depth={depth + 1} />
  {/if}
</div>

<style>
  .nested {
    border-left: 2px solid #ff3e00;
    padding-left: 0.4rem;
    font-size: 0.85rem;
  }
</style>
