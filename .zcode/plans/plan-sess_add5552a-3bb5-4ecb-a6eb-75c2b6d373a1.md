# Svelte 5 DevTools — Build Plan

## What I verified (against Svelte 5.56.9, cloned locally)

The existing zip is the **built** extension v2.2.2, not source — but I identified the upstream commit (`v2.2.2` = `673b6a2`) and mapped every bundle symbol to its source file.

**Why the old tool shows an empty tree, not an error:** it reads `window.__svelte.v` for version detection, and that global still exists in Svelte 5 — so it thinks a Svelte app is present. But 100% of its actual data came from Svelte 4 dev events (`SvelteRegisterComponent`, `SvelteRegisterBlock`, six `SvelteDOM*` events) plus monkey-patching `block.m/p/d` fragment lifecycle methods, and reading state via `$capture_state()`/`$inject_state()` on `SvelteComponentDev` instances. **All of that was deleted in Svelte 5.** There is nothing to fix; the data source is gone.

**What Svelte 5 gives us instead** (each confirmed by reading source):

| Mechanism | File | Reachable from an extension? |
|---|---|---|
| `element.__svelte_meta = { parent: dev_stack, loc: {file,line,column} }` | `internal/client/dev/elements.js:31` | **Yes** — plain DOM property |
| `DevStackEntry { file, type, line, column, parent, componentTag }`, `type` ∈ `component\|if\|each\|await\|key\|render` | `internal/client/types.d.ts:203` | **Yes**, via `__svelte_meta.parent` chain |
| `window.__svelte.v` (Set of versions) | `internal/disclose-version.js:5` | **Yes** |
| Effect tree: `parent/first/last/next/prev`, `nodes.start/end`, DEV `component_function`, `dev_stack` | `reactivity/effects.js:86-120`, `:416` | No — no global root registry |
| `component_context { p, s, x, r, function }` | `context.js:177-194` | No — module-scoped `let` |
| `$state` proxies, `STATE_SYMBOL`, `PROXY_PATH_SYMBOL` | `proxy.js:25`, `constants.js:62` | Only if you hold a reference |

Two hard blockers for a pure extension: **(1)** `dev_stack` and `component_context` are module-scoped `let` bindings — unreachable without *being* an importer of that module instance; there is no `__REACT_DEVTOOLS_GLOBAL_HOOK__` equivalent (I grepped; `disclose-version.js` is the only place Svelte touches `window` for tooling). **(2)** There are no mount/unmount events. Upstream issue [#11389](https://github.com/sveltejs/svelte/issues/11389) tracks this, open since 2024-04 with 2 comments; the PR that added `dev_stack` ([#16255](https://github.com/sveltejs/svelte/pull/16255), shipped 5.35.1) says explicitly *"This deliberately doesn't include any firing of events yet."*

**Prior art:** no official Svelte 5 devtools and **no browser extension of any kind** for Svelte 5. `sveltejs/svelte-devtools` is de facto abandoned (last release 2024-05-29, no rewrite branch, issue #193 locked). Every working Svelte 5 inspector is a **Vite plugin**, including `vite-devtools-svelte` by core-team member baseballyama, which aliases `svelte/internal/client` to a wrapper module to patch `push`/`pop`/`tag`. A DOM-driven *extension* is unoccupied territory.

## Architecture: hybrid, two tiers

You were away when I asked, so I'm taking the option I'd recommend: **works standalone, unlocks more with an optional plugin.** This avoids the fatal flaw of each pure approach (DOM-only can't read state; plugin-only does nothing until users configure their build).

- **Tier 1 — extension alone, zero config.** Any Svelte ≥5.35.1 app built with `dev: true`. Component tree, hover highlight, element picker, jump-to-source, search, keyboard nav.
- **Tier 2 — optional `svelte5-devtools-vite` plugin.** Aliases `svelte/internal/client` to a wrapper (the technique proven by `vite-devtools-svelte`) and installs a real devtools hook on `window`. Unlocks live `$state`/`$derived`/props read **and write**, mount/unmount/update events, effect graph, profiler.

The panel detects which tier is active and degrades gracefully, showing a dismissible hint about the plugin when in Tier 1.

```
Panel (Svelte 5 runes)  ──port──▶  service worker  ──▶  ISOLATED shim  ──postMessage──▶  agent.js (MAIN world)
                                                                                              │
                                                              Tier 1: walk document + __svelte_meta
                                                              Tier 2: window.__SVELTE_DEVTOOLS_HOOK__
```

I'll keep the old tool's message envelope (`{source, tabId, type, payload}`) and its `bypass::`/`bridge::` routing, since that layer is framework-agnostic and already battle-tested, and keep node shape `{id, type, tagName, detail:{attributes, listeners, ctx}}` so the tree/search/keyboard/highlight UI logic ports over.

## Tree construction (Tier 1) — the core algorithm

Svelte 5 has no component instances to enumerate, so the tree is **derived from the DOM upward**:

1. `document.querySelectorAll('*')`, keep elements with `__svelte_meta`.
2. For each, walk `__svelte_meta.parent` to get its `DevStackEntry` chain (already render-tree semantics — Rich Harris settled this in #16255 so `{@render children()}` is the parent, matching what users see).
3. **Intern entries into a node graph.** `DevStackEntry` objects are identity-stable per call site (`add_svelte_meta` creates one entry reused across children), so a `Map` keyed on the entry object dedupes siblings into shared parents correctly.
4. Attach DOM elements as leaves under their nearest entry; synthesize group nodes for `each`/`if`/`await`/`key`/`render`; label components from `componentTag`.
5. Live updates via a `MutationObserver` on `document`, debounced through `requestAnimationFrame`, re-walking only affected subtrees.

This is genuinely new work — no existing project does this in an extension — so I'll build it behind a small test harness (a sample Vite+Svelte 5 app in `playground/`) and iterate against real output rather than assuming it works first try.

## Tier 2 plugin

Virtual wrapper module, `enforce: 'pre'`, gated to `command === 'serve'`:

```js
resolveId(id) { if (id === 'svelte/internal/client') return WRAPPER_ID }
// wrapper re-exports everything, intercepting:
//   push/pop        → component mount/unmount + component_context capture
//   tag/tag_proxy   → signal labels for state display
//   template_effect → render signal (Svelte 5 has no VDOM; effect re-runs ARE renders)
```

State **writes** are simple in Svelte 5: `$state` values are proxies, so plain assignment through a captured reference triggers reactivity — no `$inject_state` equivalent needed. Reads go through `$state.snapshot`/`snapshot()` to safely serialize proxies. `structuredClone`-unsafe values (functions, symbols, cycles, DOM nodes) get the same tagged-placeholder treatment the old tool used, with cycles rendered as back-references rather than `{}` (a bug in the original).

## File layout

```
manifest.json (MV3)              packages/vite-plugin/
src/panel/     App, tree, nodes, details, search, breadcrumbs
src/agent/     core.js  tree-builder.js  highlight.js  serialize.js  hook.js
src/bridge/    background.js  shim.js
playground/    sample Svelte 5 app for testing
```

Vite + Svelte 5 runes for the panel; Rollup for the MAIN-world agent (plain IIFE, no Svelte dependency).

## Steps

1. Scaffold repo, MV3 manifest, Vite/Rollup builds, `playground/` test app.
2. Bridge layer: port plumbing, `bypass::`/`bridge::` routing, version detection, reconnect-with-backoff (the original retried blindly with no guard).
3. **Tier 1 tree builder** + `MutationObserver` — the highest-risk piece; validate against playground output before building UI on top.
4. Panel UI: tree, expand/collapse, selection, breadcrumbs, update-flash, resizable details pane.
5. Highlight overlay + element picker; fix the `position: sticky` bug the original left as a TODO.
6. Jump-to-source (`loc` → editor) and jump-to-Elements-panel; wire `panel.onShown` for `$0` sync, which the original left commented out.
7. Search, visibility filters, keyboard nav — porting logic, but replacing the original's O(n) `JSON.stringify` per keystroke with an indexed search.
8. Tier 2 plugin + hook protocol; live state read/write panel with inline editing.
9. Reactivity/dependency view and profiler built on `template_effect` interception (Tier 2 only).
10. README documenting the two tiers, the ≥5.35.1 and `dev: true` requirements, and Firefox loading instructions.

## Constraints to flag up front

- Requires **Svelte ≥ 5.35.1** (when `__svelte_meta.parent` landed) and a **dev build**; production builds emit no metadata and are fundamentally uninspectable. Tier 1 will detect and explain this rather than showing an empty tree.
- Components that render **no DOM elements** are invisible in Tier 1 (nothing to hang metadata on). Tier 2 fixes this.
- Chrome 121+ / Firefox 121+, matching the original's MV3 `world: 'MAIN'` baseline. I could not verify 2025-26 Chrome policy changes from this environment, so I'll confirm the `world: 'MAIN'` + `web_accessible_resources` route still works early in step 2 rather than at the end.
