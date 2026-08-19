/**
 * Boots the playground with the Tier 2 hook active, in Node.
 *
 * The plugin's wrapper works by aliasing `svelte/internal/client` in the module
 * graph, which needs a bundler. To test the same interception without Vite, the
 * generated hook code is executed and then the real runtime's `push`/`pop`/`tag`
 * exports are wrapped in place, which is the same interception the wrapper
 * performs — just installed at runtime instead of at resolve time.
 */
import { createDom, loadComponent, root } from './harness.js';
import { join } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';

export async function bootPlaygroundWithHook() {
  const dom = createDom();

  // Extract the hook source the plugin generates, so the test exercises the
  // real shipped code rather than a copy.
  const pluginSource = readFileSync(join(root, 'packages/vite-plugin/src/index.js'), 'utf8');
  const match = pluginSource.match(/function hook\(\) \{\s*return `([\s\S]*?)`;\s*\n\}/);
  if (!match) throw new Error('could not extract hook source from the plugin');
  const hookSource = match[1].replace(/\\`/g, '`').replace(/\\\$/g, '$');

  const outDir = join(root, 'node_modules', '.probe');
  mkdirSync(outDir, { recursive: true });
  const hookFile = join(outDir, 'devtools-hook.mjs');
  writeFileSync(hookFile, hookSource);

  const { hook } = await import(pathToFileURL(hookFile).href + '?t=' + Date.now());

  // Install the same interception the wrapper module performs.
  const client = await import('svelte/internal/client');
  const real = { push: client.push, pop: client.pop, tag: client.tag, tag_proxy: client.tag_proxy };

  // `svelte/internal/client` exports are read-only ES bindings, so patching
  // them requires intercepting at the component level instead. The compiled
  // components call `$.push(...)`; since the harness rewrites imports into a
  // namespace object, that namespace can be proxied.
  const patched = new Proxy(client, {
    get(target, prop) {
      if (prop === 'push') {
        return (props, runes, fn) => {
          const result = real.push(props, runes, fn);
          try {
            hook.pushComponent(props, fn);
          } catch {}
          return result;
        };
      }
      if (prop === 'pop') {
        return (component) => {
          try {
            hook.popComponent(component);
          } catch {}
          return real.pop(component);
        };
      }
      if (prop === 'tag') {
        return (source, label) => {
          try {
            hook.tagSignal(source, label);
          } catch {}
          return real.tag(source, label);
        };
      }
      if (prop === 'tag_proxy') {
        return (value, label) => {
          try {
            hook.tagSignal(value, label);
          } catch {}
          return real.tag_proxy(value, label);
        };
      }
      return target[prop];
    }
  });

  globalThis.__svelteClientOverride = patched;

  const svelte = await import('svelte');
  const App = (await loadComponent(join(root, 'playground/src/App.svelte'))).default;
  svelte.mount(App, { target: dom.window.document.getElementById('app') });
  svelte.flushSync();

  return {
    dom,
    document: dom.window.document,
    window: dom.window,
    flushSync: svelte.flushSync,
    hook: dom.window.__SVELTE_DEVTOOLS_HOOK__ ?? globalThis.window?.__SVELTE_DEVTOOLS_HOOK__
  };
}
