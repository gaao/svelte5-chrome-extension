<script>
  let { item, ondelete } = $props();
</script>

<li class:done={item.done}>
  <input type="checkbox" bind:checked={item.done} />
  <span>{item.text}</span>
  <button onclick={() => ondelete(item.id)}>×</button>
</li>

<style>
  .done span {
    text-decoration: line-through;
    opacity: 0.6;
  }
  li {
    display: flex;
    gap: 0.4rem;
    align-items: center;
  }
</style>
