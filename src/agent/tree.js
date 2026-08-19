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
export function buildTree({ root = document } = {}) {
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
export function formatTree(node, depth = 0) {
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
