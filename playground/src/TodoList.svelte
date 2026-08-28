<script>
  import TodoRow from './TodoRow.svelte';

  let items = $state([
    { id: 1, text: 'Study __svelte_meta', done: true },
    { id: 2, text: 'Build the tree', done: false },
    { id: 3, text: 'Ship the panel', done: false }
  ]);

  let nextId = 4;
  let remaining = $derived(items.filter((i) => !i.done).length);

  function add() {
    items.push({ id: nextId++, text: `New task ${nextId}`, done: false });
  }

  function remove(id) {
    items = items.filter((i) => i.id !== id);
  }
</script>

<h2>Todos ({remaining} remaining)</h2>

<ul>
  <!-- each block wrapping a component, so component-inside-each is exercised -->
  {#each items as item (item.id)}
    <TodoRow {item} ondelete={remove} />
  {/each}
</ul>

<button onclick={add}>add todo</button>

<style>
  .done span {
    text-decoration: line-through;
    opacity: 0.6;
  }
  ul {
    list-style: none;
    padding-left: 0;
  }
  li {
    display: flex;
    gap: 0.4rem;
    align-items: center;
  }
</style>
