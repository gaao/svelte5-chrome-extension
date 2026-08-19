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
import { buildTree, formatTree } from './tree.js';
import { serialize, serializeNode } from './serialize.js';
import { createObserver } from './observer.js';
import { highlight, clearHighlight, destroyHighlight } from './highlight.js';
import { readState, writeState, hasHook } from './state.js';

const SOURCE = 'svelte-devtools';
const GLOBAL = '#SvelteDevTools';

/** @type {ReturnType<typeof buildTree> | null} */
let tree = null;
let observer = null;
let inspecting = false;
let selectedId = null;

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
    selectedId = id;
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
    selectedId = id;
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
