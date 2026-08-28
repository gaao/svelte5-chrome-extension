<script>
  /**
   * One row in the component tree, rendered recursively.
   *
   * Uses a snippet for the recursion so the whole subtree stays in one
   * component, which keeps expand/collapse state and keyboard navigation
   * working off the shared store rather than per-instance state.
   */
  import { app, select, hover, toggleCollapsed } from '../runtime.svelte.js';
  import TreeNode from './TreeNode.svelte';

  let { id, depth = 0 } = $props();

  const node = $derived(app.nodes.get(id));
  const visible = $derived(!!node && app.visibility[node.type] !== false);
  const collapsed = $derived(app.collapsed.has(id));
  const selected = $derived(app.selectedId === id);
  const isMatch = $derived(app.matches.includes(id));

  /**
   * Children to render. Types the user has filtered out are skipped, but their
   * descendants are pulled up so hiding a wrapper does not hide real content.
   */
  const shownChildren = $derived.by(() => {
    if (!node) return [];
    const out = [];
    const visit = (childId) => {
      const child = app.nodes.get(childId);
      if (!child) return;
      if (app.visibility[child.type] === false) {
        for (const grandchild of child.children) visit(grandchild);
      } else {
        out.push(childId);
      }
    };
    for (const child of node.children) visit(child);
    return out;
  });

  const hasChildren = $derived(shownChildren.length > 0);
  const flashing = $derived(app.recentlyChanged.has(id));

  function label(n) {
    if (n.type === 'element') return n.tagName;
    if (n.type === 'iteration') return `${n.tagName}`;
    return n.tagName;
  }
</script>

{#if visible && node}
  <div
    class="row"
    class:selected
    class:match={isMatch}
    class:flash={flashing}
    style="padding-left: {depth * 12 + 4}px"
    data-node-id={id}
    onclick={(e) => {
      e.stopPropagation();
      select(id);
    }}
    onmouseenter={() => hover(id)}
    ondblclick={(e) => {
      e.stopPropagation();
      toggleCollapsed(id);
    }}
    onkeydown={(e) => {
      // Row-level keys only; global tree navigation lives in App.svelte so it
      // works regardless of which row has focus.
      if (e.key === ' ') {
        e.preventDefault();
        toggleCollapsed(id);
      }
    }}
    role="treeitem"
    aria-selected={selected}
    aria-expanded={hasChildren ? !collapsed : undefined}
    tabindex="-1"
  >
    <button
      class="twisty"
      class:hidden={!hasChildren}
      onclick={(e) => {
        e.stopPropagation();
        toggleCollapsed(id);
      }}
      aria-label={collapsed ? 'Expand' : 'Collapse'}
    >
      {collapsed ? '▶' : '▼'}
    </button>

    {#if node.type === 'element'}
      <span class="punct">&lt;</span><span class="tag">{label(node)}</span
      >{#each node.attributes ?? [] as attr (attr.key)}<span class="attr"
          >&nbsp;{attr.key}{#if attr.value}<span class="punct">=</span><span class="value"
              >"{attr.value.length > 24 ? attr.value.slice(0, 24) + '…' : attr.value}"</span
            >{/if}</span
        >{/each}<span class="punct">&gt;</span>
      {#if node.text}<span class="text">{node.text}</span>{/if}
    {:else if node.type === 'iteration'}
      <span class="iteration">{label(node)}</span>
    {:else}
      <span class="component" class:block={node.type !== 'component'}>{label(node)}</span>
      {#if node.type !== 'component'}<span class="kind">{node.type}</span>{/if}
    {/if}

    {#if selected}<span class="marker">== $n</span>{/if}
  </div>

  {#if hasChildren && !collapsed}
    {#each shownChildren as childId (childId)}
      <TreeNode id={childId} depth={depth + 1} />
    {/each}
  {/if}
{/if}

<style>
  .row {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 1px 4px;
    font: 11px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    white-space: nowrap;
    cursor: default;
    user-select: none;
  }
  .row:hover {
    background: var(--hover);
  }
  .row.selected {
    background: var(--selected);
  }
  .row.match {
    outline: 1px solid var(--accent);
    outline-offset: -1px;
  }
  .row.flash {
    animation: flash 0.6s ease-out;
  }
  @keyframes flash {
    from {
      background: rgba(255, 62, 0, 0.35);
    }
    to {
      background: transparent;
    }
  }
  .twisty {
    width: 12px;
    flex: none;
    background: none;
    border: 0;
    padding: 0;
    color: var(--dim);
    font-size: 8px;
    cursor: pointer;
  }
  .twisty.hidden {
    visibility: hidden;
  }
  .tag {
    color: var(--tag);
  }
  .component {
    color: var(--component);
    font-weight: 600;
  }
  .component.block {
    color: var(--block);
    font-weight: 500;
  }
  .kind {
    color: var(--dim);
    font-size: 10px;
  }
  .iteration {
    color: var(--dim);
  }
  .attr {
    color: var(--attr);
  }
  .value {
    color: var(--string);
  }
  .punct {
    color: var(--dim);
  }
  .text {
    color: var(--fg);
    margin-left: 4px;
    opacity: 0.75;
  }
  .marker {
    color: var(--dim);
    margin-left: 6px;
    font-style: italic;
  }
</style>
