<script>
  /**
   * Panel root: toolbar, component tree, breadcrumbs and details pane.
   */
  import {
    app,
    select,
    clearHover,
    setCollapsed,
    toggleCollapsed,
    toggleInspect,
    scrollIntoView,
    inspectInElements,
    openSource,
    reloadPage,
    runSearch,
    stepSearch,
    writeState,
    revealAndSelect,
    setEditor
  } from './lib/runtime.svelte.js';
  import TreeNode from './lib/nodes/TreeNode.svelte';
  import PropertyList from './lib/panel/PropertyList.svelte';

  /**
   * IDEs launch-editor knows how to launch. The `id` is passed to the Tier 2
   * plugin as `?editor=`; `''` leaves it to Vite to auto-detect the editor
   * that has the project open.
   */
  const EDITORS = [
    { id: '', label: 'Editor: auto-detect' },
    { id: 'code', label: 'Visual Studio Code' },
    { id: 'code-insiders', label: 'VS Code Insiders' },
    { id: 'cursor', label: 'Cursor' },
    { id: 'trae', label: 'Trae' },
    { id: 'antigravity', label: 'Antigravity' },
    { id: 'windsurf', label: 'Windsurf' },
    { id: 'codium', label: 'VSCodium' },
    { id: 'webstorm', label: 'WebStorm' },
    { id: 'zed', label: 'Zed' },
    { id: 'subl', label: 'Sublime Text' }
  ];

  let detailsWidth = $state(380);
  let resizing = $state(false);
  /** @type {HTMLElement | undefined} */
  let treeEl = $state();

  const selected = $derived(app.selectedId ? app.nodes.get(app.selectedId) : null);
  const detail = $derived(app.detail);

  /** Ancestor chain for the breadcrumb bar, outermost first. */
  const breadcrumbs = $derived.by(() => {
    const chain = [];
    let node = selected;
    while (node) {
      chain.unshift(node);
      node = node.parent ? app.nodes.get(node.parent) : null;
    }
    return chain;
  });

  /**
   * Flattened list of currently visible rows, in display order. Keyboard
   * navigation walks this rather than the raw tree so hidden types and
   * collapsed subtrees are skipped automatically.
   */
  const visibleRows = $derived.by(() => {
    const out = [];
    const visit = (id) => {
      const node = app.nodes.get(id);
      if (!node) return;
      const shown = app.visibility[node.type] !== false;
      if (shown) out.push(id);
      if (shown && app.collapsed.has(id)) return;
      for (const child of node.children) visit(child);
    };
    if (app.rootId) visit(app.rootId);
    return out;
  });

  function move(delta) {
    if (!visibleRows.length) return;
    const current = app.selectedId ? visibleRows.indexOf(app.selectedId) : -1;
    const next = current === -1 ? 0 : Math.min(visibleRows.length - 1, Math.max(0, current + delta));
    select(visibleRows[next]);
  }

  function onKeydown(event) {
    // Let the search box and value editors handle their own keys.
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        move(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        move(-1);
        break;
      case 'ArrowRight': {
        event.preventDefault();
        if (!selected) return;
        if (app.collapsed.has(selected.id)) setCollapsed(selected.id, false);
        else move(1);
        break;
      }
      case 'ArrowLeft': {
        event.preventDefault();
        if (!selected) return;
        if (!app.collapsed.has(selected.id) && selected.children.length) {
          setCollapsed(selected.id, true);
        } else if (selected.parent) {
          select(selected.parent);
        }
        break;
      }
      case 'Enter':
        if (selected) {
          event.preventDefault();
          toggleCollapsed(selected.id);
        }
        break;
      case 'Escape':
        if (app.inspecting) {
          event.preventDefault();
          toggleInspect();
        }
        break;
    }
  }

  // Keep the selected row scrolled into view as the user navigates.
  $effect(() => {
    if (!app.selectedId || !treeEl) return;
    const row = treeEl.querySelector(`[data-node-id="${app.selectedId}"]`);
    row?.scrollIntoView?.({ block: 'nearest' });
  });

  function startResize(event) {
    resizing = true;
    const startX = event.clientX;
    const startWidth = detailsWidth;

    const onMove = (e) => {
      detailsWidth = Math.min(Math.max(240, startWidth - (e.clientX - startX)), 900);
    };
    const onUp = () => {
      resizing = false;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  const sections = $derived.by(() => {
    if (!detail) return [];
    const out = [];
    if (detail.attributes?.length) {
      out.push({ title: 'Attributes', entries: detail.attributes.map((a) => ({ key: a.key, value: a.value })), editable: false });
    }
    if (detail.listeners?.length) {
      out.push({
        title: 'Events',
        entries: detail.listeners.map((l) => ({
          key: l.event,
          value: { __is: 'function', name: l.event, source: l.handler }
        })),
        editable: false
      });
    }
    if (detail.state) {
      const entries = Object.entries(detail.state)
        .filter(([, v]) => v !== undefined)
        .map(([key, value]) => ({ key, value }));
      if (entries.length) {
        out.push({ title: detail.tier === 2 ? 'State' : 'Info', entries, editable: detail.tier === 2 });
      }
    }
    return out;
  });
</script>

<svelte:window onkeydown={onKeydown} />

<div class="layout">
  <div class="toolbar">
    <button
      class="icon"
      class:active={app.inspecting}
      onclick={toggleInspect}
      title="Select an element in the page (Esc to cancel)"
      aria-label="Inspect element"
    >
      ⊹
    </button>

    <div class="search">
      <input
        placeholder="Search tree"
        value={app.search}
        oninput={(e) => runSearch(e.currentTarget.value)}
        onkeydown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            stepSearch(e.shiftKey ? -1 : 1);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            runSearch('');
          }
        }}
      />
      {#if app.search}
        <span class="count">
          {app.matches.length ? app.matchIndex + 1 : 0} / {app.matches.length}
        </span>
        <button class="icon small" onclick={() => stepSearch(-1)} aria-label="Previous match">↑</button>
        <button class="icon small" onclick={() => stepSearch(1)} aria-label="Next match">↓</button>
      {/if}
    </div>

    <details class="filter">
      <summary title="Filter node types">Filter</summary>
      <div class="filter-menu">
        {#each Object.keys(app.visibility) as type (type)}
          <label>
            <input type="checkbox" bind:checked={app.visibility[type]} />
            {type}
          </label>
        {/each}
      </div>
    </details>

    <label class="editor-picker" title="IDE used by “open in editor”">
      <span class="editor-glyph">⤢</span>
      <select bind:value={app.editor} onchange={(e) => setEditor(e.currentTarget.value)}>
        <option value="">Editor: auto</option>
        {#each EDITORS as ide (ide.id)}
          <option value={ide.id}>{ide.label}</option>
        {/each}
      </select>
    </label>

    <span class="spacer"></span>

    {#if app.status.tier === 1 && app.status.hasMeta}
      <span class="badge" title="Add the svelte5-devtools Vite plugin to inspect and edit live state">
        Tier 1
      </span>
    {:else if app.status.tier === 2}
      <span class="badge on" title="Vite plugin detected: live state available">Tier 2</span>
    {/if}
    {#if app.status.major}
      <span class="version">Svelte {app.status.versions.join(', ')}</span>
    {/if}
  </div>

  {#if !app.status.connected}
    <div class="message">Connecting…</div>
  {:else if !app.status.major}
    <div class="message">
      <p><strong>No Svelte application detected</strong></p>
      <p>This page does not expose <code>window.__svelte</code>.</p>
      <button onclick={reloadPage}>Reload page</button>
    </div>
  {:else if !app.status.hasMeta}
    <div class="message">
      <p><strong>Svelte {app.status.versions.join(', ')} found, but no dev metadata</strong></p>
      <p>
        The component tree is built from <code>__svelte_meta</code>, which Svelte only emits when
        compiled with <code>dev: true</code>. Production builds cannot be inspected.
      </p>
      <p class="dim">Requires Svelte 5.35.1 or newer.</p>
      <button onclick={reloadPage}>Reload page</button>
    </div>
  {:else}
    <div class="main">
      <div
        class="tree"
        bind:this={treeEl}
        onmouseleave={clearHover}
        role="tree"
        aria-label="Svelte component tree"
        tabindex="-1"
      >
        {#if app.rootId}
          <TreeNode id={app.rootId} />
        {:else}
          <div class="message dim">Waiting for the first render…</div>
        {/if}
      </div>

      <button
        class="resizer"
        class:active={resizing}
        onmousedown={startResize}
        aria-label="Resize details pane"
      ></button>

      <div class="details" style="width: {detailsWidth}px">
        {#if selected}
          <div class="details-head">
            <span class="title">{selected.tagName}</span>
            <span class="kind">{selected.type}</span>
            <span class="spacer"></span>
            {#if selected.loc}
              <button class="icon small" onclick={() => openSource(selected.id)} title="Open in editor">
                ↗
              </button>
            {/if}
            <button class="icon small" onclick={() => scrollIntoView(selected.id)} title="Scroll into view">
              ⤓
            </button>
            {#if selected.type === 'element'}
              <button
                class="icon small"
                onclick={() => inspectInElements(selected.id)}
                title="Reveal in Elements panel"
              >
                ⊡
              </button>
            {/if}
          </div>

          {#if selected.loc}
            <div class="loc">{selected.loc.file}:{selected.loc.line}:{selected.loc.column}</div>
          {/if}

          {#if app.error}
            <div class="error">{app.error}</div>
          {/if}

          {#each sections as section (section.title)}
            <section>
              <h3>{section.title}</h3>
              <PropertyList
                entries={section.entries}
                editable={section.editable}
                onedit={(path, value) => writeState(selected.id, path, value)}
              />
            </section>
          {/each}

          {#if detail?.note}
            <p class="note">{detail.note}</p>
          {/if}
        {:else}
          <div class="message dim">Select a node to inspect it.</div>
        {/if}
      </div>
    </div>

    <div class="breadcrumbs">
      {#each breadcrumbs as node, i (node.id)}
        {#if i > 0}<span class="sep">›</span>{/if}
        <button onclick={() => revealAndSelect(node.id)}>
          {node.type === 'element' ? `<${node.tagName}>` : node.tagName}
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .layout {
    display: flex;
    flex-direction: column;
    height: 100vh;
    overflow: hidden;
  }
  .toolbar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 6px;
    border-bottom: 1px solid var(--border);
    flex: none;
  }
  .spacer {
    flex: 1;
  }
  .icon {
    background: none;
    border: 1px solid transparent;
    border-radius: 3px;
    color: var(--fg);
    cursor: pointer;
    padding: 2px 6px;
    font-size: 13px;
    line-height: 1.2;
  }
  .icon:hover {
    background: var(--hover);
  }
  .icon.active {
    background: var(--accent);
    color: #fff;
  }
  .icon.small {
    font-size: 11px;
    padding: 1px 5px;
  }
  .search {
    display: flex;
    align-items: center;
    gap: 3px;
  }
  .search input {
    background: var(--input-bg);
    border: 1px solid var(--border);
    border-radius: 3px;
    color: var(--fg);
    padding: 2px 5px;
    width: 150px;
    font-size: 11px;
  }
  .count {
    color: var(--dim);
    font-size: 10px;
    min-width: 40px;
  }
  .filter {
    position: relative;
  }
  .editor-picker {
    display: flex;
    align-items: center;
    gap: 3px;
  }
  .editor-glyph {
    color: var(--dim);
    font-size: 12px;
  }
  .editor-picker select {
    background: var(--input-bg);
    border: 1px solid var(--border);
    border-radius: 3px;
    color: var(--fg);
    font-size: 11px;
    padding: 1px 2px;
    max-width: 130px;
    cursor: pointer;
  }
  .filter summary {
    cursor: pointer;
    font-size: 11px;
    padding: 2px 6px;
    border-radius: 3px;
    list-style: none;
  }
  .filter summary:hover {
    background: var(--hover);
  }
  .filter-menu {
    position: absolute;
    top: 100%;
    left: 0;
    z-index: 10;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 6px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    box-shadow: 0 4px 12px rgb(0 0 0 / 0.25);
  }
  .filter-menu label {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 11px;
    white-space: nowrap;
  }
  .badge {
    font-size: 10px;
    padding: 1px 5px;
    border-radius: 8px;
    border: 1px solid var(--border);
    color: var(--dim);
  }
  .badge.on {
    background: var(--accent);
    border-color: var(--accent);
    color: #fff;
  }
  .version {
    font-size: 10px;
    color: var(--dim);
  }
  .main {
    display: flex;
    flex: 1;
    min-height: 0;
  }
  .tree {
    flex: 1;
    overflow: auto;
    padding: 3px 0;
    min-width: 0;
  }
  .resizer {
    width: 4px;
    flex: none;
    border: 0;
    padding: 0;
    background: var(--border);
    cursor: col-resize;
  }
  .resizer:hover,
  .resizer.active {
    background: var(--accent);
  }
  .details {
    flex: none;
    overflow: auto;
    border-left: 1px solid var(--border);
    padding: 6px 8px;
  }
  .details-head {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .details-head .title {
    font-weight: 600;
    color: var(--component);
  }
  .details-head .kind {
    font-size: 10px;
    color: var(--dim);
  }
  .loc {
    font: 10px/1.6 ui-monospace, Menlo, Consolas, monospace;
    color: var(--dim);
    margin-bottom: 6px;
    word-break: break-all;
  }
  section h3 {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--dim);
    margin: 10px 0 3px;
    font-weight: 600;
  }
  .note {
    margin-top: 12px;
    padding: 6px 8px;
    background: var(--hover);
    border-left: 2px solid var(--accent);
    border-radius: 2px;
    font-size: 11px;
    color: var(--dim);
    line-height: 1.5;
  }
  .error {
    margin: 6px 0;
    padding: 4px 6px;
    background: rgb(255 0 0 / 0.1);
    border-left: 2px solid var(--error);
    font-size: 11px;
    color: var(--error);
  }
  .breadcrumbs {
    display: flex;
    align-items: center;
    gap: 2px;
    flex: none;
    border-top: 1px solid var(--border);
    padding: 3px 6px;
    overflow-x: auto;
    white-space: nowrap;
    min-height: 22px;
  }
  .breadcrumbs button {
    background: none;
    border: 0;
    color: var(--dim);
    cursor: pointer;
    font: 10px/1.6 ui-monospace, Menlo, Consolas, monospace;
    padding: 0 2px;
    border-radius: 2px;
  }
  .breadcrumbs button:hover {
    background: var(--hover);
    color: var(--fg);
  }
  .breadcrumbs .sep {
    color: var(--dim);
    font-size: 10px;
  }
  .message {
    padding: 16px;
    font-size: 12px;
    line-height: 1.6;
  }
  .message.dim {
    color: var(--dim);
  }
  .message p {
    margin: 0 0 8px;
  }
  .message code {
    background: var(--hover);
    padding: 1px 4px;
    border-radius: 2px;
    font-size: 11px;
  }
  .message button {
    background: var(--accent);
    color: #fff;
    border: 0;
    border-radius: 3px;
    padding: 4px 10px;
    cursor: pointer;
    font-size: 11px;
  }
  .dim {
    color: var(--dim);
  }
</style>
