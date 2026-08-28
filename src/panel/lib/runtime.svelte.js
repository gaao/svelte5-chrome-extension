/**
 * Panel-side connection to the service worker, plus the reactive store the UI
 * renders from.
 */

const SOURCE = 'svelte-devtools';
const tabId = chrome.devtools.inspectedWindow.tabId;

/** @typedef {{ id: string, type: string, tagName: string, loc: any, parent: string | null, children: string[], attributes?: any[], listeners?: any[], text?: string }} PanelNode */

export const app = $state({
  /** @type {Map<string, PanelNode>} */
  nodes: new Map(),
  /** @type {string | null} */
  rootId: null,
  /** @type {string | null} */
  selectedId: null,
  /** @type {string | null} */
  hoveredId: null,
  /** Node ids the user has collapsed; everything else is expanded. */
  collapsed: new Set(),
  /** @type {any} */
  detail: null,
  /** Detection info from the page. */
  status: {
    connected: false,
    /** @type {number | null} */
    major: null,
    versions: [],
    hasMeta: false,
    tier: 1
  },
  inspecting: false,
  search: '',
  /** @type {string[]} */
  matches: [],
  matchIndex: 0,
  /** Which node types to show in the tree. */
  visibility: {
    component: true,
    element: true,
    if: true,
    each: true,
    iteration: true,
    key: true,
    await: true,
    render: true,
    block: true
  },
  /** @type {string | null} */
  error: null,
  /** Node ids that changed in the last update, for the flash animation. */
  recentlyChanged: new Set()
});

let port = null;
let reconnectDelay = 250;

function connect() {
  port = chrome.runtime.connect({ name: `${tabId}` });

  port.onMessage.addListener(receive);

  port.onDisconnect.addListener(() => {
    port = null;
    app.status.connected = false;
    // Chrome tears down ports aggressively. Back off rather than retrying in a
    // tight loop the way the Svelte 4 devtools did.
    setTimeout(() => {
      reconnectDelay = Math.min(reconnectDelay * 2, 5000);
      connect();
    }, reconnectDelay);
  });

  reconnectDelay = 250;
  send('bypass::ext/init', {});
}

export function send(type, payload = {}) {
  if (!port) return;
  try {
    port.postMessage({ source: SOURCE, tabId, type, payload });
  } catch {
    // Port died between checks; the disconnect handler will reconnect.
    port = null;
  }
}

function receive(message) {
  if (!message || message.source !== SOURCE) return;

  switch (message.type) {
    case 'bypass::ext/agent-ready':
    case 'bypass::ext/detected': {
      Object.assign(app.status, message.payload, { connected: true });
      break;
    }

    case 'bridge::agent/tree': {
      applyTree(message.payload);
      break;
    }

    case 'bridge::agent/selected': {
      app.detail = message.payload.detail;
      break;
    }

    case 'bridge::agent/inspect-result': {
      app.inspecting = false;
      select(message.payload.id);
      break;
    }

    case 'bridge::agent/state-written': {
      if (!message.payload.ok) app.error = message.payload.error ?? 'Write failed';
      break;
    }

    case 'bridge::agent/clear': {
      app.nodes = new Map();
      app.rootId = null;
      app.selectedId = null;
      app.detail = null;
      break;
    }

    case 'bypass::ext/error': {
      app.error = message.payload?.message ?? 'Unknown agent error';
      break;
    }
  }
}

function applyTree({ root, nodes }) {
  const next = new Map();
  for (const node of nodes) next.set(node.id, node);

  // Flag nodes whose rendered output changed, so the tree can flash them.
  const changed = new Set();
  for (const [id, node] of next) {
    const previous = app.nodes.get(id);
    if (!previous) continue;
    if (
      previous.text !== node.text ||
      previous.children.length !== node.children.length ||
      JSON.stringify(previous.attributes) !== JSON.stringify(node.attributes)
    ) {
      changed.add(id);
    }
  }

  app.nodes = next;
  app.rootId = root;
  app.recentlyChanged = changed;

  // Drop a stale selection, but keep it if the node still exists.
  if (app.selectedId && !next.has(app.selectedId)) {
    app.selectedId = null;
    app.detail = null;
  }

  if (app.search) runSearch(app.search);
}

// ---- actions ------------------------------------------------------------

export function select(id) {
  app.selectedId = id;
  app.error = null;
  send('bridge::ext/select', { id });
}

export function hover(id) {
  if (app.hoveredId === id) return;
  app.hoveredId = id;
  send('bridge::ext/highlight', { id });
}

export function clearHover() {
  if (app.hoveredId === null) return;
  app.hoveredId = null;
  send('bridge::ext/highlight', { id: null });
}

export function toggleCollapsed(id) {
  const next = new Set(app.collapsed);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  app.collapsed = next;
}

export function setCollapsed(id, collapsed) {
  const next = new Set(app.collapsed);
  if (collapsed) next.add(id);
  else next.delete(id);
  app.collapsed = next;
}

export function toggleInspect() {
  app.inspecting = !app.inspecting;
  send('bridge::ext/inspect', { enabled: app.inspecting });
}

export function scrollIntoView(id) {
  send('bridge::ext/scroll-into-view', { id });
}

export function reloadPage() {
  send('bypass::ext/reload', {});
}

export function writeState(id, path, value) {
  send('bridge::ext/set-state', { id, path, value });
}

/** Reveals the selected element in the Elements panel. */
export function inspectInElements(id) {
  const node = app.nodes.get(id);
  if (!node || node.type !== 'element') return;
  select(id);
  chrome.devtools.inspectedWindow.eval('inspect(window.$n)');
}

/** Opens the node's source location in the user's editor via Vite. */
export function openSource(id) {
  const node = app.nodes.get(id);
  if (!node?.loc) return;
  chrome.devtools.inspectedWindow.eval('window.location.origin', (origin) => {
    send('bypass::ext/open-source', {
      origin,
      file: node.loc.file,
      line: node.loc.line,
      column: node.loc.column
    });
  });
}

// ---- search -------------------------------------------------------------

/**
 * Builds a lowercase search index once per tree update instead of
 * re-stringifying every node on each keystroke, which is what made the Svelte 4
 * devtools' search slow on large trees.
 */
let index = new Map();
let indexedNodes = null;

function ensureIndex() {
  if (indexedNodes === app.nodes) return;
  index = new Map();
  for (const [id, node] of app.nodes) {
    const parts = [node.tagName, node.text ?? ''];
    for (const attr of node.attributes ?? []) parts.push(attr.key, String(attr.value));
    index.set(id, parts.join(' ').toLowerCase());
  }
  indexedNodes = app.nodes;
}

export function runSearch(term) {
  app.search = term;
  const query = term.trim().toLowerCase();

  if (!query) {
    app.matches = [];
    app.matchIndex = 0;
    return;
  }

  ensureIndex();

  // Keep results in tree order so stepping through them feels predictable.
  const ordered = [];
  (function walk(id) {
    const node = app.nodes.get(id);
    if (!node) return;
    if (index.get(id)?.includes(query)) ordered.push(id);
    for (const child of node.children) walk(child);
  })(app.rootId);

  app.matches = ordered;
  app.matchIndex = 0;
  if (ordered.length) revealAndSelect(ordered[0]);
}

export function stepSearch(delta) {
  if (!app.matches.length) return;
  app.matchIndex = (app.matchIndex + delta + app.matches.length) % app.matches.length;
  revealAndSelect(app.matches[app.matchIndex]);
}

/** Expands ancestors so a node becomes visible, then selects it. */
export function revealAndSelect(id) {
  const next = new Set(app.collapsed);
  let node = app.nodes.get(id);
  while (node?.parent) {
    next.delete(node.parent);
    node = app.nodes.get(node.parent);
  }
  app.collapsed = next;
  select(id);
}

// Let the devtools page push Elements-panel selections into the tree.
window.__svelteDevtoolsSelectFromElements = (id) => {
  if (app.nodes.has(id)) revealAndSelect(id);
};

connect();
