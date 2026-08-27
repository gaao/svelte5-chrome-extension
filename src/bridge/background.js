/**
 * Service worker: routes messages between devtools panels and inspected pages,
 * and injects the MAIN-world agent.
 *
 * Message envelope: `{ source, tabId, type, payload }`.
 *
 *   `bypass::*` — handled here, never forwarded to the page
 *   `bridge::*` — relayed between panel and page
 *
 * Injection needs two worlds. The agent itself must run in the MAIN world,
 * because `element.__svelte_meta` and `window.__svelte` are page-realm values
 * that an isolated content script cannot read. But MAIN-world code has no
 * `chrome.runtime` access, so a small ISOLATED-world shim relays between
 * `window.postMessage` and the extension.
 */

const SOURCE = 'svelte-devtools';

/** @type {Map<number, chrome.runtime.Port>} */
const ports = new Map();
/** Tabs that already have the agent injected, to avoid double-injection. */
const injected = new Set();

chrome.runtime.onConnect.addListener((port) => {
  // Only accept connections from our own panel page.
  const expected = chrome.runtime.getURL('/index.html');
  if (port.sender?.url !== expected) {
    console.error(`[svelte-devtools] unexpected connection from ${port.sender?.url}`);
    return port.disconnect();
  }

  const tabId = Number(port.name);
  if (!Number.isInteger(tabId)) return port.disconnect();

  ports.set(tabId, port);

  port.onMessage.addListener((message) => {
    if (!message || message.source !== SOURCE) return;

    switch (message.type) {
      case 'bypass::ext/init':
        inject(tabId);
        return;

      case 'bypass::ext/reload':
        injected.delete(tabId);
        chrome.tabs.reload(tabId, { bypassCache: true });
        return;

      case 'bypass::ext/open-source':
        openSource(message.payload);
        return;

      default:
        // Everything else is destined for the page.
        chrome.tabs.sendMessage(tabId, message).catch(() => {
          // The content script may not be ready yet; re-inject and retry once.
          injected.delete(tabId);
          inject(tabId).then(() => {
            chrome.tabs.sendMessage(tabId, message).catch(() => {});
          });
        });
    }
  });

  port.onDisconnect.addListener(() => {
    ports.delete(tabId);
    injected.delete(tabId);
  });
});

/** Page -> panel. */
chrome.runtime.onMessage.addListener((message, sender) => {
  if (!message || message.source !== SOURCE) return;
  const tabId = sender.tab?.id;
  if (tabId === undefined) return;

  if (message.type === 'bypass::ext/detected' || message.type === 'bypass::ext/agent-ready') {
    setIcon(tabId, message.payload);
  }

  ports.get(tabId)?.postMessage(message);
});

/** Re-inject on navigation so the panel keeps working across page loads. */
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status !== 'loading') return;
  injected.delete(tabId);
  if (ports.has(tabId)) inject(tabId);
});

/**
 * Injects the ISOLATED-world shim and then the MAIN-world agent.
 *
 * The agent is attached as a `<script src>` pointing at a web-accessible
 * resource rather than through `world: 'MAIN'` + `files`, because module
 * scripts injected via `files` do not share the page's module registry and
 * cannot be loaded as ES modules there.
 */
async function inject(tabId) {
  if (injected.has(tabId)) return;
  injected.add(tabId);

  try {
    // 1. Relay between the extension and the page realm.
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      world: 'ISOLATED',
      func: shim,
      args: [SOURCE]
    });

    // 2. Load the agent into the page realm as a module.
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      world: 'MAIN',
      func: attach,
      args: [chrome.runtime.getURL('agent.js')]
    });
  } catch (error) {
    injected.delete(tabId);
    // Restricted URLs (chrome://, the web store) simply cannot be inspected.
    console.debug('[svelte-devtools] injection failed:', error?.message);
  }
}

/**
 * Runs in the ISOLATED world. Serialized and re-parsed by `executeScript`, so
 * it must be self-contained with no closure over outer scope.
 */
function shim(SOURCE) {
  if (window.__svelteDevtoolsShim) return;
  window.__svelteDevtoolsShim = true;

  // extension -> page
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.source === SOURCE) window.postMessage(message, '*');
  });

  // page -> extension
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const message = event.data;
    if (message?.source !== SOURCE) return;
    // Only forward agent-originated traffic, never our own relayed messages.
    if (typeof message.type !== 'string') return;
    if (!message.type.startsWith('bridge::agent/') && !message.type.startsWith('bypass::')) return;
    try {
      chrome.runtime.sendMessage(message);
    } catch {
      // The extension context can go away during navigation.
    }
  });
}

/**
 * Runs in the MAIN world; loads the agent into the page.
 *
 * A classic script, not `type="module"`: the agent is bundled as a self-
 * contained IIFE, and a classic `<script src>` to a web-accessible extension
 * resource executes immediately on insertion. A module script from a
 * chrome-extension:// URL injected into an http page is deferred and subject to
 * module CORS rules that reliably leave it unexecuted.
 */
function attach(src) {
  if (document.querySelector(`script[data-svelte-devtools-agent]`)) return;
  const script = document.createElement('script');
  script.src = src;
  script.dataset.svelteDevtoolsAgent = '';
  script.async = false;
  (document.head || document.documentElement).appendChild(script);
}

/** Reflects Svelte detection in the toolbar icon. */
function setIcon(tabId, info) {
  const enabled = !!info?.major;
  const variant = enabled ? 'default' : 'disabled';
  chrome.action
    ?.setIcon({
      tabId,
      path: {
        16: `icons/${variant}-16.png`,
        32: `icons/${variant}-32.png`,
        48: `icons/${variant}-48.png`,
        128: `icons/${variant}-128.png`
      }
    })
    .catch(() => {});
}

/**
 * Opens a component source location. Vite's dev server exposes
 * `/__open-in-editor`, which is what the official Svelte inspector uses.
 */
async function openSource({ origin, file, line, column } = {}) {
  if (!origin || !file) return;
  const url = `${origin}/__open-in-editor?file=${encodeURIComponent(`${file}:${line ?? 1}:${(column ?? 0) + 1}`)}`;
  try {
    await fetch(url);
  } catch {
    // No dev server, or it does not support the endpoint.
  }
}
