/**
 * Tier 1 tree builder.
 *
 * Reconstructs a Svelte 5 component tree purely from DOM state, using the
 * dev-mode `element.__svelte_meta` metadata that Svelte attaches in
 * `internal/client/dev/elements.js`:
 *
 *     element.__svelte_meta = {
 *       parent: DevStackEntry | null,
 *       loc: { file, line, column }
 *     }
 *
 *     DevStackEntry = {
 *       file, type, line, column,
 *       parent: DevStackEntry | null,
 *       componentTag?: string
 *     }
 *
 * Observed semantics that this builder relies on (verified against Svelte
 * 5.56.9 by mounting a real app and inspecting the live objects):
 *
 *   - Entry objects are created by `add_svelte_meta` once per *block creation*,
 *     so they are identity-stable and shared by every element rendered inside
 *     that block. Interning on object identity therefore groups siblings.
 *   - A component instantiated N times produces N distinct entries, so
 *     component instances are naturally distinguished.
 *   - An `{#each}` block creates a single entry shared by *all* iterations.
 *     Iteration boundaries are consequently not recoverable from metadata
 *     alone and are inferred from repeating child source locations instead.
 *   - Snippet content chains through the `{@render}` call site, which yields
 *     render-tree placement (where content appears) rather than lexical
 *     placement (where it was written).
 */

const GROUP_TYPES = new Set(['component', 'if', 'each', 'await', 'key', 'render']);

let uid = 0;
const nextId = () => `n${++uid}`;

/** Human-readable label for a metadata entry. */
function entryLabel(entry) {
  if (entry.type === 'component') return entry.componentTag || basename(entry.file) || 'Component';
  return entry.type;
}

function basename(file) {
  if (!file) return '';
  const name = file.split(/[\\/]/).pop() || '';
  return name.replace(/\.svelte$/, '');
}

/**
 * Builds the tree.
 *
 * @param {object} [options]
 * @param {Document | Element} [options.root] subtree to scan
 * @returns {{ root: object | null, byId: Map<string, object>, elements: Map<Element, object>, stats: object }}
 */
function buildTree({ root = document } = {}) {
  uid = 0;

  const byId = new Map();
  /** @type {Map<Element, object>} node for each metadata-bearing element */
  const elementNodes = new Map();
  /** @type {Map<object, object>} interned group node per DevStackEntry */
  const groupNodes = new Map();

  const scanRoot = root.documentElement ?? root;
  const candidates = [scanRoot, ...scanRoot.querySelectorAll('*')].filter(
    (el) => el.__svelte_meta
  );

  if (candidates.length === 0) {
    return { root: null, byId, elements: elementNodes, stats: { elements: 0, groups: 0 } };
  }

  const makeNode = (node) => {
    byId.set(node.id, node);
    return node;
  };

  /** The synthetic root: the component that was mounted. */
  const rootFile = candidates[0].__svelte_meta.loc.file;
  const rootNode = makeNode({
    id: nextId(),
    type: 'component',
    tagName: basename(rootFile) || 'Root',
    file: rootFile,
    loc: null,
    parent: null,
    children: [],
    entry: null
  });

  /** Resolves (and creates on demand) the group node for a metadata entry. */
  function groupFor(entry) {
    if (!entry) return rootNode;
    const existing = groupNodes.get(entry);
    if (existing) return existing;

    const node = makeNode({
      id: nextId(),
      type: GROUP_TYPES.has(entry.type) ? entry.type : 'block',
      tagName: entryLabel(entry),
      file: entry.file,
      loc: { file: entry.file, line: entry.line, column: entry.column },
      parent: null,
      children: [],
      entry,
      // Logical owner from the metadata chain. The final DOM position is
      // resolved in pass 3, which may nest this group deeper.
      owner: null
    });
    groupNodes.set(entry, node);
    node.owner = groupFor(entry.parent);
    return node;
  }

  // Pass 1 — create a node per metadata-bearing element and ensure its group
  // chain exists. Document order guarantees ancestors are visited first.
  for (const el of candidates) {
    const meta = el.__svelte_meta;
    const owner = groupFor(meta.parent);

    const node = makeNode({
      id: nextId(),
      type: 'element',
      tagName: el.tagName.toLowerCase(),
      file: meta.loc.file,
      loc: meta.loc,
      parent: null,
      children: [],
      owner,
      element: el
    });
    elementNodes.set(el, node);
  }

  // Record the first element rendered inside each group, in document order.
  // A group's DOM position is defined by where its content actually appears.
  const anchors = new Map();
  for (const el of candidates) {
    for (let entry = el.__svelte_meta.parent; entry; entry = entry.parent) {
      if (!anchors.has(entry)) anchors.set(entry, el);
    }
  }

  /**
   * Finds the node a child should attach to: the nearest metadata-bearing DOM
   * ancestor that belongs to the same group, so visual nesting is preserved
   * inside a group while group boundaries restructure the tree.
   */
  function domParentWithin(el, owner) {
    for (let ancestor = el.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const ancestorNode = elementNodes.get(ancestor);
      if (ancestorNode) {
        return ancestorNode.owner === owner ? ancestorNode : null;
      }
    }
    return null;
  }

  // Pass 2 — attach group nodes, outermost first so parents exist before
  // children. Depth is measured along the metadata chain.
  const depthOf = (node) => {
    let d = 0;
    for (let p = node.owner; p; p = p.owner) d++;
    return d;
  };
  const groups = [...groupNodes.values()].sort((a, b) => depthOf(a) - depthOf(b));

  for (const group of groups) {
    const anchor = anchors.get(group.entry);
    const domParent = anchor ? domParentWithin(anchor, group.owner) : null;
    const parent = domParent ?? group.owner;
    group.parent = parent;
    parent.children.push(group);
  }

  // Pass 3 — attach elements the same way.
  for (const el of candidates) {
    const node = elementNodes.get(el);
    const parent = domParentWithin(el, node.owner) ?? node.owner;
    node.parent = parent;
    parent.children.push(node);
  }

  // Restore document order within each parent. Groups are ordered by their
  // anchor element so a component appears where its output appears.
  const orderKey = new Map();
  candidates.forEach((el, i) => orderKey.set(el, i));
  const positionOf = (node) => {
    if (node.type === 'element') return orderKey.get(node.element) ?? 0;
    const anchor = anchors.get(node.entry);
    return anchor ? (orderKey.get(anchor) ?? 0) : 0;
  };
  for (const node of byId.values()) {
    node.children.sort((a, b) => positionOf(a) - positionOf(b));
  }

  synthesizeIterations(rootNode, byId);
  assignComponentIdentity(rootNode);

  return {
    root: rootNode,
    byId,
    elements: elementNodes,
    stats: { elements: elementNodes.size, groups: groupNodes.size }
  };
}

/**
 * Annotates component nodes with the information the Tier 2 hook needs.
 *
 * A component entry's `file`/`line` point at the *call site* (where `<Counter />`
 * is written), not at the component's own source file. The hook keys its
 * registry by the component's own file, which is recoverable from the elements
 * the component renders. Instance order follows document order, matching the
 * order `push` runs during mount.
 */
function assignComponentIdentity(root) {
  const counters = new Map();

  const ownFileOf = (node) => {
    // The first descendant element that is not itself inside a nested component
    // was rendered by this component, so its `loc.file` is this component's file.
    const queue = [...node.children];
    while (queue.length) {
      const child = queue.shift();
      if (child.type === 'element') return child.loc?.file ?? null;
      if (child.type === 'component') continue;
      queue.push(...child.children);
    }
    return null;
  };

  (function walk(node) {
    if (node.type === 'component') {
      const file = ownFileOf(node);
      node.componentFile = file;
      if (file) {
        const seen = counters.get(file) ?? 0;
        node.instanceIndex = seen;
        counters.set(file, seen + 1);
      }
    }
    for (const child of node.children) walk(child);
  })(root);
}

/**
 * `{#each}` blocks share one metadata entry across every iteration, so the
 * iteration structure has to be inferred. Within an each-group, the child
 * template repeats, so a child whose source location equals the first child's
 * location marks the start of a new iteration.
 */
function synthesizeIterations(node, byId) {
  for (const child of node.children) synthesizeIterations(child, byId);

  if (node.type !== 'each' || node.children.length === 0) return;

  const keyOf = (n) => (n.loc ? `${n.loc.file}:${n.loc.line}:${n.loc.column}` : n.tagName);
  const firstKey = keyOf(node.children[0]);

  /** @type {object[][]} */
  const chunks = [];
  for (const child of node.children) {
    if (chunks.length === 0 || keyOf(child) === firstKey) chunks.push([child]);
    else chunks[chunks.length - 1].push(child);
  }

  // A single chunk means one iteration — no need to add a synthetic layer.
  if (chunks.length < 2) return;

  node.children = chunks.map((chunk, i) => {
    const iteration = {
      id: nextId(),
      type: 'iteration',
      tagName: `${i}`,
      file: node.file,
      loc: node.loc,
      parent: node,
      children: chunk,
      entry: null
    };
    byId.set(iteration.id, iteration);
    for (const c of chunk) c.parent = iteration;
    return iteration;
  });
}

/** Renders the tree as indented text. Used by tests and debugging. */
function formatTree(node, depth = 0) {
  if (!node) return '(no svelte app detected)';
  const pad = '  '.repeat(depth);
  const loc = node.loc ? ` @${node.loc.line}:${node.loc.column}` : '';
  const label =
    node.type === 'element'
      ? `<${node.tagName}>`
      : node.type === 'iteration'
        ? `[${node.tagName}]`
        : `${node.tagName} (${node.type})`;
  const lines = [`${pad}${label}${loc}`];
  for (const child of node.children) lines.push(formatTree(child, depth + 1));
  return lines.join('\n');
}

/**
 * Value serialization for transport between the page and the devtools panel.
 *
 * Messages cross a `postMessage` boundary, so every value has to survive
 * structured cloning. Functions, symbols, DOM nodes, Svelte state proxies and
 * cyclic references all need explicit handling.
 *
 * Placeholders use an `__is` tag so the panel can render them distinctly.
 * Unlike the Svelte 4 devtools, repeated objects become explicit back-references
 * (`{ __is: 'circular', path }`) instead of silently collapsing to `{}`.
 */

const MAX_DEPTH = 6;
const MAX_KEYS = 100;
const MAX_ARRAY = 100;
const MAX_STRING = 10_000;

/**
 * @param {unknown} value
 * @param {object} [options]
 * @param {number} [options.depth] maximum nesting depth
 * @returns {unknown} a structured-clone-safe representation
 */
function serialize(value, { depth = MAX_DEPTH } = {}) {
  return walk(value, depth, new Map(), '$');
}

function walk(value, budget, seen, path) {
  if (value === null) return null;

  const type = typeof value;

  if (type === 'string') {
    return value.length > MAX_STRING ? value.slice(0, MAX_STRING) + '…' : value;
  }
  if (type === 'number' || type === 'boolean') {
    return Number.isNaN(value) ? { __is: 'nan' } : value;
  }
  if (type === 'undefined') return { __is: 'undefined' };
  if (type === 'bigint') return { __is: 'bigint', value: value.toString() };
  if (type === 'symbol') return { __is: 'symbol', name: value.description ?? '' };
  if (type === 'function') {
    return {
      __is: 'function',
      name: value.name || '(anonymous)',
      source: truncateSource(value)
    };
  }

  // Objects from here on.
  if (seen.has(value)) return { __is: 'circular', path: seen.get(value) };

  if (isNode(value)) {
    return {
      __is: 'node',
      name: nodeName(value)
    };
  }

  if (value instanceof Date) return { __is: 'date', value: value.toISOString() };
  if (value instanceof RegExp) return { __is: 'regexp', value: String(value) };
  if (value instanceof Error) {
    return { __is: 'error', name: value.name, message: value.message };
  }

  if (budget <= 0) {
    return { __is: 'truncated', preview: preview(value) };
  }

  seen.set(value, path);

  try {
    if (value instanceof Map) {
      const entries = [];
      let i = 0;
      for (const [k, v] of value) {
        if (i >= MAX_KEYS) break;
        entries.push([walk(k, budget - 1, seen, `${path}.@${i}k`), walk(v, budget - 1, seen, `${path}.@${i}v`)]);
        i++;
      }
      return { __is: 'map', size: value.size, entries };
    }

    if (value instanceof Set) {
      const items = [];
      let i = 0;
      for (const v of value) {
        if (i >= MAX_KEYS) break;
        items.push(walk(v, budget - 1, seen, `${path}.@${i}`));
        i++;
      }
      return { __is: 'set', size: value.size, items };
    }

    if (Array.isArray(value)) {
      const out = value
        .slice(0, MAX_ARRAY)
        .map((v, i) => walk(v, budget - 1, seen, `${path}[${i}]`));
      if (value.length > MAX_ARRAY) {
        out.push({ __is: 'truncated', preview: `… ${value.length - MAX_ARRAY} more items` });
      }
      return out;
    }

    // Plain-ish object.
    const out = {};
    const keys = Reflect.ownKeys(value).filter((k) => typeof k === 'string');
    for (const key of keys.slice(0, MAX_KEYS)) {
      let descriptor;
      try {
        descriptor = Object.getOwnPropertyDescriptor(value, key);
      } catch {
        continue;
      }
      // Reading a getter can throw or have side effects; report it instead.
      if (descriptor && !('value' in descriptor)) {
        out[key] = { __is: 'getter' };
        continue;
      }
      try {
        out[key] = walk(value[key], budget - 1, seen, `${path}.${key}`);
      } catch (error) {
        out[key] = { __is: 'error', name: 'ThrewOnRead', message: String(error) };
      }
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

function truncateSource(fn) {
  let source;
  try {
    source = fn.toString();
  } catch {
    return '(source unavailable)';
  }
  return source.length > 500 ? source.slice(0, 500) + '…' : source;
}

function isNode(value) {
  return typeof Node !== 'undefined' && value instanceof Node;
}

function nodeName(node) {
  if (node.nodeType === 1) {
    const el = /** @type {Element} */ (node);
    const id = el.id ? `#${el.id}` : '';
    const cls =
      typeof el.className === 'string' && el.className.trim()
        ? `.${el.className.trim().split(/\s+/).join('.')}`
        : '';
    return `<${el.tagName.toLowerCase()}${id}${cls}>`;
  }
  return `#${node.nodeName.toLowerCase()}`;
}

function preview(value) {
  if (Array.isArray(value)) return `Array(${value.length})`;
  const name = value?.constructor?.name;
  return name && name !== 'Object' ? name : 'Object';
}

/**
 * Serializes a tree node into the shape the panel consumes. DOM references and
 * metadata entry objects are dropped, since neither can cross postMessage.
 */
function serializeNode(node) {
  const el = node.element;
  return {
    id: node.id,
    type: node.type,
    tagName: node.tagName,
    loc: node.loc ? { ...node.loc } : null,
    parent: node.parent?.id ?? null,
    children: node.children.map((c) => c.id),
    attributes: el ? attributesOf(el) : [],
    listeners: el ? listenersOf(el) : [],
    text: el ? directText(el) : ''
  };
}

function attributesOf(el) {
  return [...el.attributes]
    .filter((a) => a.name !== 'class' || a.value.trim() !== '')
    .map((a) => ({ key: a.name, value: a.value }));
}

/**
 * Svelte 5 stores delegated handlers in an object under a private symbol
 * (`event_symbol = Symbol('events')` in
 * `internal/client/dom/elements/events.js`), keyed by event name. That symbol
 * is not exported, so it is located by description on whichever element first
 * exposes it. Non-delegated handlers go through `addEventListener` and are not
 * enumerable from script at all, so they cannot be listed.
 */
function eventSymbolOf(el) {
  for (const key of Reflect.ownKeys(el)) {
    if (typeof key === 'symbol' && key.description === 'events') return key;
  }
  return null;
}

function listenersOf(el) {
  const symbol = eventSymbolOf(el);
  if (!symbol) return [];

  const map = el[symbol];
  if (!map || typeof map !== 'object') return [];

  const out = [];
  for (const [event, handler] of Object.entries(map)) {
    if (typeof handler === 'function') {
      out.push({ event, handler: truncateSource(handler) });
    }
  }
  return out;
}

/** Direct text content, excluding text inside child elements. */
function directText(el) {
  let text = '';
  for (const child of el.childNodes) {
    if (child.nodeType === 3) text += child.nodeValue;
  }
  text = text.trim();
  return text.length > 120 ? text.slice(0, 120) + '…' : text;
}

/**
 * Watches the document and reports when the Svelte tree needs rebuilding.
 *
 * Svelte 5 emits no lifecycle events for tooling (upstream issue #11389), so
 * DOM mutation is the only available change signal in Tier 1. Mutations are
 * coalesced through `requestAnimationFrame` because a single state update can
 * produce hundreds of individual records.
 */
function createObserver(onChange, { root = document } = {}) {
  let frame = 0;
  let pending = false;

  const flush = () => {
    frame = 0;
    if (!pending) return;
    pending = false;
    onChange();
  };

  const schedule = () => {
    pending = true;
    if (frame) return;
    frame =
      typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame(flush)
        : setTimeout(flush, 16);
  };

  const observer = new MutationObserver((records) => {
    // Ignore mutations caused by our own highlight overlay.
    for (const record of records) {
      if (isOurs(record.target)) continue;
      schedule();
      return;
    }
  });

  observer.observe(root.documentElement ?? root, {
    childList: true,
    subtree: true,
    attributes: true,
    characterData: true
  });

  return {
    stop() {
      observer.disconnect();
      if (frame) {
        if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
        else clearTimeout(frame);
      }
    }
  };
}

function isOurs(node) {
  const el = node?.nodeType === 1 ? node : node?.parentElement;
  return !!el?.closest?.('[data-svelte-devtools]');
}

/**
 * In-page highlight overlay for the selected/hovered node.
 *
 * Boxes are appended to `document.body` and tagged with `data-svelte-devtools`
 * so the mutation observer ignores them.
 *
 * The Svelte 4 devtools positioned boxes by adding `scrollX/scrollY` to
 * `getBoundingClientRect()` and branching on `position: fixed`, which left a
 * `// TODO: handle sticky position` bug where sticky elements were highlighted
 * at the wrong offset. This uses viewport coordinates with `position: fixed`
 * instead, so it is correct for static, absolute, fixed and sticky elements
 * alike, and needs no scroll compensation at all.
 */

const CONTAINER_ID = 'svelte-devtools-highlight';

let container = null;
let raf = 0;
/** @type {{ element: Element, label: string } | null} */
let target = null;

function ensureContainer() {
  if (container && container.isConnected) return container;

  container = document.createElement('div');
  container.id = CONTAINER_ID;
  container.setAttribute('data-svelte-devtools', 'highlight');
  Object.assign(container.style, {
    position: 'fixed',
    inset: '0',
    pointerEvents: 'none',
    zIndex: '2147483647',
    contain: 'strict'
  });

  container.innerHTML = `
    <div data-part="box" style="
      position: fixed;
      background: rgba(255, 62, 0, 0.18);
      border: 1px solid rgba(255, 62, 0, 0.9);
      box-sizing: border-box;
      pointer-events: none;
      display: none;
    "></div>
    <div data-part="label" style="
      position: fixed;
      background: #ff3e00;
      color: #fff;
      font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
      padding: 1px 5px;
      border-radius: 3px;
      white-space: nowrap;
      pointer-events: none;
      display: none;
    "></div>
  `;

  document.body.appendChild(container);
  return container;
}

function draw() {
  raf = 0;
  const root = ensureContainer();
  const box = root.querySelector('[data-part="box"]');
  const label = root.querySelector('[data-part="label"]');

  if (!target || !target.element.isConnected) {
    box.style.display = 'none';
    label.style.display = 'none';
    return;
  }

  const rect = target.element.getBoundingClientRect();

  // Zero-area elements have nothing meaningful to outline.
  if (rect.width === 0 && rect.height === 0) {
    box.style.display = 'none';
    label.style.display = 'none';
    return;
  }

  Object.assign(box.style, {
    display: 'block',
    top: `${rect.top}px`,
    left: `${rect.left}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`
  });

  label.textContent = target.label;
  label.style.display = 'block';

  // Prefer above the element; fall back to inside when there is no room.
  const labelRect = label.getBoundingClientRect();
  const above = rect.top - labelRect.height - 2;
  Object.assign(label.style, {
    top: `${above < 0 ? Math.min(rect.top + 2, window.innerHeight - labelRect.height) : above}px`,
    left: `${Math.max(0, Math.min(rect.left, window.innerWidth - labelRect.width))}px`
  });
}

function schedule() {
  if (raf) return;
  raf = requestAnimationFrame(draw);
}

/** Highlights an element. Pass `null` to clear. */
function highlight(element, label = '') {
  target = element ? { element, label } : null;
  schedule();

  if (target) {
    // Keep the box glued to the element while the page scrolls or resizes.
    window.addEventListener('scroll', schedule, { passive: true, capture: true });
    window.addEventListener('resize', schedule, { passive: true });
  } else {
    window.removeEventListener('scroll', schedule, { capture: true });
    window.removeEventListener('resize', schedule);
  }
}

function clearHighlight() {
  highlight(null);
}

/**
 * Reactive state access.
 *
 * Svelte 5 keeps component state in module-scoped signals inside
 * `svelte/internal/client`, so there is no way to enumerate a component's
 * `$state`/`$derived` from outside that module instance. `component_context`
 * and `dev_stack` are module-level `let` bindings, and no global devtools hook
 * exists (upstream issue #11389 tracks adding one).
 *
 * Consequently:
 *   - Tier 1 (extension only) reports the DOM-observable facts and explains
 *     that live state needs the Vite plugin.
 *   - Tier 2 reads through `window.__SVELTE_DEVTOOLS_HOOK__`, installed by our
 *     Vite plugin, which captures `push`/`pop` and signal labels.
 *
 * Writing state is comparatively easy once a reference exists: `$state` values
 * are proxies (`proxy.js`), so ordinary assignment triggers reactivity. No
 * `$inject_state` equivalent is required.
 */

const HOOK = '__SVELTE_DEVTOOLS_HOOK__';

function hasHook() {
  return typeof window !== 'undefined' && !!window[HOOK];
}

function hook() {
  return window[HOOK];
}

/**
 * Reads the state associated with a tree node.
 *
 * @returns {{ tier: 1 | 2, values: object, note?: string }}
 */
function readState(node) {
  if (!node) return { tier: 1, values: {} };

  if (hasHook()) {
    const record = hook().stateFor?.(descriptorFor(node));
    if (record) return { tier: 2, values: record };
  }

  // Tier 1 fallback: surface what the metadata alone can tell us.
  return {
    tier: 1,
    values: {
      source: node.loc ? `${node.loc.file}:${node.loc.line}:${node.loc.column}` : undefined,
      blockType: node.type
    },
    note: 'Live $state requires the svelte5-devtools Vite plugin. Add it to see props, $state and $derived values.'
  };
}

/**
 * Describes a node for the hook. Components are looked up by their own source
 * file plus instance index, since `loc` on a component node refers to the call
 * site in the parent rather than the component's own file.
 */
function descriptorFor(node) {
  return {
    loc: node.componentFile ? { file: node.componentFile } : node.loc,
    file: node.componentFile ?? node.file,
    instanceIndex: node.instanceIndex ?? 0
  };
}

/**
 * Writes a value into reactive state.
 *
 * @param {object} node
 * @param {string[]} path property path within the component's state
 * @param {unknown} value already-parsed value
 * @returns {{ ok: boolean, error?: string }}
 */
function writeState(node, path, value) {
  if (!hasHook()) {
    return { ok: false, error: 'Editing state requires the svelte5-devtools Vite plugin.' };
  }
  if (!node || !path?.length) return { ok: false, error: 'Nothing to write.' };

  try {
    const target = hook().targetFor?.(descriptorFor(node), path.slice(0, -1));
    if (!target || typeof target !== 'object') {
      return { ok: false, error: 'Target is not writable.' };
    }
    // `$state` values are proxies, so a plain assignment is enough to notify
    // subscribers; no internal `set()` call is needed.
    target[path[path.length - 1]] = value;
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

/**
 * MAIN-world agent.
 *
 * Runs in the page's JavaScript context (not the extension's isolated world),
 * which is required because `element.__svelte_meta` and `window.__svelte` are
 * page-realm values that an isolated content script cannot see.
 *
 * Communicates with the extension via `window.postMessage`, which an isolated
 * shim relays to the service worker and on to the panel.
 */

const SOURCE = 'svelte-devtools';
const GLOBAL = '#SvelteDevTools';

/** @type {ReturnType<typeof buildTree> | null} */
let tree = null;
let observer = null;
let inspecting = false;

function send(type, payload) {
  window.postMessage({ source: SOURCE, type, payload }, '*');
}

/** Detects the Svelte version and which capability tier is available. */
function detect() {
  const versions = [...(window.__svelte?.v ?? [])];
  const major = versions.length ? Math.max(...versions.map((v) => parseInt(v, 10) || 0)) : null;
  return {
    versions,
    major,
    // Tier 2 is active when the Vite plugin has installed its hook.
    tier: hasHook() ? 2 : 1,
    hasMeta: !!document.querySelector('*')?.__svelte_meta || probeMeta()
  };
}

/** True when any element carries dev metadata (i.e. this is a dev build). */
function probeMeta() {
  for (const el of document.querySelectorAll('*')) {
    if (el.__svelte_meta) return true;
  }
  return false;
}

function rebuild() {
  tree = buildTree({ root: document });
  const nodes = [...tree.byId.values()].map(serializeNode);
  send('bridge::agent/tree', {
    root: tree.root?.id ?? null,
    nodes,
    stats: tree.stats
  });
}

function nodeById(id) {
  return tree?.byId.get(id) ?? null;
}

/** A short human label for the highlight overlay. */
function labelFor(node) {
  if (!node) return '';
  if (node.type === 'element') return `<${node.tagName}>`;
  if (node.type === 'iteration') return `#${node.tagName}`;
  return `${node.tagName}`;
}

/**
 * The DOM element that visually represents a node. Group nodes (components,
 * blocks) have no element of their own, so the first element rendered inside
 * them is used instead.
 */
function elementFor(node) {
  if (!node) return null;
  if (node.element) return node.element;
  for (const child of node.children) {
    const found = elementFor(child);
    if (found) return found;
  }
  return null;
}

// ---- inspect mode -------------------------------------------------------

function elementToNodeId(el) {
  if (!tree) return null;
  for (let current = el; current; current = current.parentElement) {
    const node = tree.elements.get(current);
    if (node) return node.id;
  }
  return null;
}

function onInspectMove(event) {
  const el = event.target;
  if (!(el instanceof Element)) return;
  const id = elementToNodeId(el);
  const node = id ? nodeById(id) : null;
  if (node) highlight(node.element, labelFor(node));
}

function onInspectClick(event) {
  event.preventDefault();
  event.stopPropagation();
  const el = event.target;
  const id = el instanceof Element ? elementToNodeId(el) : null;
  stopInspecting();
  if (id) {
    send('bridge::agent/inspect-result', { id });
  }
}

function startInspecting() {
  if (inspecting) return;
  inspecting = true;
  document.addEventListener('mousemove', onInspectMove, true);
  document.addEventListener('click', onInspectClick, true);
}

function stopInspecting() {
  if (!inspecting) return;
  inspecting = false;
  document.removeEventListener('mousemove', onInspectMove, true);
  document.removeEventListener('click', onInspectClick, true);
  clearHighlight();
}

// ---- message handling ---------------------------------------------------

const handlers = {
  'bridge::ext/init'() {
    const info = detect();
    send('bypass::ext/detected', info);
    if (info.hasMeta) {
      observer?.stop();
      observer = createObserver(rebuild);
      rebuild();
    }
  },

  'bridge::ext/refresh'() {
    rebuild();
  },

  'bridge::ext/highlight'({ id }) {
    const node = id ? nodeById(id) : null;
    const el = elementFor(node);
    if (el) highlight(el, labelFor(node));
    else clearHighlight();
  },

  'bridge::ext/select'({ id }) {
    const node = nodeById(id);
    const el = elementFor(node);
    // Expose the selection as `$n`, mirroring the Svelte 4 devtools.
    if (el) window.$n = el;
    send('bridge::agent/selected', { id, detail: detailFor(node) });
  },

  'bridge::ext/scroll-into-view'({ id }) {
    const el = elementFor(nodeById(id));
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  },

  'bridge::ext/inspect'({ enabled }) {
    if (enabled) startInspecting();
    else stopInspecting();
  },

  'bridge::ext/set-state'({ id, path, value }) {
    const node = nodeById(id);
    const result = writeState(node, path, value);
    send('bridge::agent/state-written', { id, path, ...result });
    if (result.ok) rebuild();
  }
};

/** Props/state/attributes for the details panel. */
function detailFor(node) {
  if (!node) return null;

  const base = {
    id: node.id,
    type: node.type,
    tagName: node.tagName,
    loc: node.loc ? { ...node.loc } : null
  };

  if (node.type === 'element') {
    const serialized = serializeNode(node);
    return { ...base, attributes: serialized.attributes, listeners: serialized.listeners };
  }

  // Components and blocks: state comes from the Tier 2 hook when present.
  const state = readState(node);
  return { ...base, state: serialize(state.values), tier: state.tier, note: state.note };
}

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const message = event.data;
  if (!message || message.source !== SOURCE) return;
  const handler = handlers[message.type];
  if (handler) {
    try {
      handler(message.payload ?? {});
    } catch (error) {
      send('bypass::ext/error', { type: message.type, message: String(error?.stack || error) });
    }
  }
});

window.addEventListener('beforeunload', () => {
  send('bridge::agent/clear', {});
});

// A page-world handle, useful for manual debugging from the console and for
// the panel's `inspectedWindow.eval` calls.
window[GLOBAL] = {
  rebuild,
  detect,
  get tree() {
    return tree;
  },
  dump() {
    return formatTree(tree?.root);
  },
  nodeById,
  elementFor,
  /**
   * Maps a DOM element to the id of the nearest tree node. Used by the
   * devtools page to mirror the Elements panel's `$0` selection.
   */
  nodeIdForElement(el) {
    return el instanceof Element ? elementToNodeId(el) : null;
  }
};

// Announce readiness; the panel replies with `ext/init`.
send('bypass::ext/agent-ready', detect());
//# sourceMappingURL=agent.js.map
