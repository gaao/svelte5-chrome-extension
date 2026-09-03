# Svelte 5 DevTools

A browser devtools extension for inspecting Svelte 5 applications: component
tree, source locations, DOM highlighting, and live reactive state.

The existing [`sveltejs/svelte-devtools`](https://github.com/sveltejs/svelte-devtools)
only supports Svelte 4. This is a rewrite for Svelte 5, which required a
completely different approach — see [How it works](#how-it-works).

## Status

Working and covered by 117 automated assertions across five test suites. Not yet
verified inside a real browser (see [Verification](#verification)), so treat it
as a working prototype rather than a polished release.

## Features

| | Tier 1 (extension only) | Tier 2 (+ Vite plugin) |
|---|:---:|:---:|
| Component tree with components, `if`/`each`/`await`/`key` blocks and snippets | ✅ | ✅ |
| Element rows with attributes and delegated event handlers | ✅ | ✅ |
| Hover highlighting in the page | ✅ | ✅ |
| Element picker (click a node in the page to select it) | ✅ | ✅ |
| Source location per node, and "open in editor" | ✅ (auto-detect IDE) | ✅ (choose your IDE) |
| Reveal in the Elements panel, and `$0` → tree sync | ✅ | ✅ |
| Indexed search with prev/next, node-type filters, keyboard navigation | ✅ | ✅ |
| Breadcrumbs, resizable details pane, update flash | ✅ | ✅ |
| **Props, `$state` and `$derived` values** | ❌ | ✅ |
| **Editing state from the panel** | ❌ | ✅ |

Tier 1 needs no configuration and works on any dev-built Svelte 5 app. Tier 2
requires adding a Vite plugin to your own project, which is the only way to
reach reactive state — the reason is explained below.

## Requirements

- **Svelte 5.35.1 or newer.** The tree is built from `__svelte_meta.parent`,
  which shipped in 5.35.1 ([svelte#16255](https://github.com/sveltejs/svelte/pull/16255)).
- **A development build** (`dev: true`, the default for `vite dev`). Production
  builds emit no metadata at all and cannot be inspected. The panel detects this
  and says so rather than showing an empty tree.
- Chrome 121+ or Firefox 121+.

## Install

```bash
npm install
npm run build
```

Then load `build/` as an unpacked extension:

- **Chrome** — `chrome://extensions` → enable Developer mode → *Load unpacked* → select `build/`
- **Firefox** — `about:debugging#/runtime/this-firefox` → *Load Temporary Add-on* → select `build/manifest.json`.
  Firefox also needs *Always Allow on localhost* for the extension to attach to a dev server.

Open devtools and pick the **Svelte** tab.

### Tier 2: live state

Install the plugin in the app you want to inspect and put it *before*
`vite-plugin-svelte`, so it can alias the Svelte runtime before components are
compiled against it:

```js
// vite.config.js
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { svelteDevtools } from 'svelte5-devtools-vite';

export default {
  plugins: [svelteDevtools(), svelte()]
};
```

The plugin only activates for `vite serve`; production builds are untouched.

### Choosing an IDE for "open in editor"

The toolbar has an editor picker (auto-detect, VS Code, VS Code Insiders, Cursor,
Trae, Antigravity, Windsurf, VSCodium, WebStorm, Zed, Sublime Text). The choice
persists across sessions. Opening a specific IDE goes through the Tier 2
plugin's `/__svelte-devtools/open` endpoint; without the plugin the click falls
back to Vite's built-in endpoint, which opens whichever editor it detected
running.

## How it works

Svelte 5 deleted every mechanism the Svelte 4 devtools depended on:

| Svelte 4 | Svelte 5 |
|---|---|
| `SvelteRegisterComponent` / `SvelteRegisterBlock` events | removed |
| Six `SvelteDOM*` mutation events | removed |
| Patching `block.m`/`p`/`d` fragment lifecycle methods | no fragments to patch |
| `$capture_state()` / `$inject_state()` on component instances | components are no longer class instances |

There is also no Svelte equivalent of React's `__REACT_DEVTOOLS_GLOBAL_HOOK__`.
`window.__svelte` holds only a version `Set`. Upstream issue
[svelte#11389](https://github.com/sveltejs/svelte/issues/11389) tracks providing
tooling metadata and has been open since April 2024.

### Tier 1: the tree comes from the DOM

In dev mode Svelte tags every element it creates
(`internal/client/dev/elements.js`):

```js
element.__svelte_meta = {
  parent: dev_stack,                       // chain of DevStackEntry
  loc: { file, line, column }
};
```

Each `DevStackEntry` has `{ file, type, line, column, parent, componentTag }`
where `type` is one of `component`, `if`, `each`, `await`, `key`, `render`.
Walking `parent` from every element and interning the entries reconstructs the
render tree. Live updates come from a `MutationObserver`, coalesced through
`requestAnimationFrame`.

Three behaviours were established by mounting a real app and inspecting the
objects, not by reading docs:

- **Entries are identity-stable per block creation** and shared by every element
  inside that block, so interning on object identity groups siblings correctly.
- **A component instantiated *N* times produces *N* entries**, which is what makes
  per-instance state lookup possible.
- **An `{#each}` block shares one entry across all iterations.** Iteration
  boundaries are therefore *not* recoverable from metadata and are inferred from
  repeating child source locations.

Snippet content chains through the `{@render}` call site, so it appears where it
renders rather than where it was written — matching the semantics Rich Harris
settled on in svelte#16255.

**Tier 1 limitation:** a component that renders no DOM elements has nowhere to
hang metadata, so it is invisible. Tier 2 fixes this.

### Tier 2: the plugin gets inside the module

`component_context` and `dev_stack` are module-scoped `let` bindings inside
`svelte/internal/client`. Nothing outside that module instance can read them, so
an extension alone cannot see reactive state. The only way in is to *be* an
importer, which requires build-time cooperation.

The plugin aliases `svelte/internal/client` to a wrapper that re-exports
everything and intercepts three functions:

- `push(props, runes, fn)` — runs at the start of every component; `fn` carries
  the `FILENAME` symbol, so instances can be registered and ordered
- `pop()` — closes the current instance
- `tag(signal, label)` — Svelte's own dev labelling, which supplies `$state` and
  `$derived` names

Captured state is published on `window.__SVELTE_DEVTOOLS_HOOK__` for the
extension to read. Writing needs no special API: `$state` values are proxies, so
a plain assignment triggers reactivity.

### Extension architecture

```
panel (Svelte 5 runes)
  │  port, name = tabId
service worker ── handles bypass:: locally, relays bridge:: onward
  │  chrome.tabs.sendMessage
ISOLATED shim ── bridges chrome.runtime <-> window.postMessage
  │  postMessage
agent (MAIN world) ── reads __svelte_meta, builds the tree
```

The agent must run in the MAIN world to see page-realm values, but MAIN-world
code has no `chrome.runtime`, hence the shim.

## Improvements over the Svelte 4 devtools

- **`position: sticky` highlighting** — the original had a `// TODO: handle
  sticky position` bug; using viewport coordinates with `position: fixed` makes
  static, absolute, fixed and sticky elements all correct with no scroll
  compensation.
- **Elements panel → tree sync** — the original left `panel.onShown` commented
  out, so only tree → Elements worked.
- **Search performance** — the original ran `JSON.stringify` over every node on
  every keystroke; this builds a lowercase index once per tree update.
- **Cycles in inspected values** render as explicit back-references with a path
  rather than collapsing to `{}`.
- **Port reconnection** backs off instead of retrying immediately in a loop.
- **A working profiler is deliberately absent** rather than shipped broken — the
  original's was commented out and its button inert.

## Development

```bash
npm run dev         # rebuild panel and agent on change
npm run playground  # sample Svelte 5 app with the Tier 2 plugin, port 5273
npm test            # all five suites
npm run check       # svelte-check
```

### Verification

Testing runs through a jsdom harness that compiles the playground in dev mode
against the real Svelte client runtime, so assertions are made against genuine
runtime data rather than fixtures.

| Suite | Covers |
|---|---|
| `test-tree` | tree structure, component instances, block types, each-iteration synthesis, DOM ordering |
| `test-agent` | structured-clone-safe serialization, listener discovery, observer coalescing |
| `test-plugin` | module-graph rewriting against a real Vite dev server; hook capture against the real runtime |
| `test-integration` | tree ↔ hook correlation per instance, writes reaching the DOM, Tier 1 fallback |
| `test-panel` | panel rendering, selection, details, search, filtering, degraded states |

Two limitations of this environment are worth knowing about:

- **jsdom cannot execute ES modules**, so the plugin is verified in two parts —
  module-graph rewriting over HTTP, and hook behaviour in Node — rather than as
  one browser-style integration test.
- **No Chrome extension host was available**, so the message bridge
  (service worker, ISOLATED shim, MAIN-world injection) is *not* covered by
  automated tests. It needs manual verification: load the extension, open the
  playground, and confirm the tree appears.

## License

MIT
