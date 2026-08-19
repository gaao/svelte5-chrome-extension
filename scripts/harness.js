/**
 * Boots the playground app inside jsdom against the real dev-compiled Svelte
 * client runtime, so agent code can be exercised against genuine
 * `__svelte_meta` data without a browser.
 *
 * Must be run with `node --conditions=browser`, otherwise Node resolves
 * Svelte's server build and `mount()` throws.
 */
import { JSDOM } from 'jsdom';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compile, compileModule } from 'svelte/compiler';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function createDom() {
  const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
    url: 'http://localhost:5273/',
    pretendToBeVisual: true
  });

  for (const key of [
    'window',
    'document',
    'navigator',
    'Node',
    'Element',
    'HTMLElement',
    'HTMLInputElement',
    'HTMLTextAreaElement',
    'HTMLSelectElement',
    'HTMLMediaElement',
    'HTMLAnchorElement',
    'SVGElement',
    'Text',
    'Comment',
    'DocumentFragment',
    'CustomEvent',
    'Event',
    'MouseEvent',
    'KeyboardElement',
    'KeyboardEvent',
    'MutationObserver',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'getComputedStyle',
    'DOMParser'
  ]) {
    if (globalThis[key] === undefined && dom.window[key] !== undefined) {
      globalThis[key] = dom.window[key];
    }
  }

  return dom;
}

const cache = new Map();
globalThis.__deps = {};

/**
 * Compiles a .svelte file (and its relative imports) in dev mode and imports
 * the result. Self-importing components are supported via a lazy placeholder
 * registered before dependency resolution.
 */
export async function loadComponent(file) {
  const abs = resolve(file);
  if (cache.has(abs)) return cache.get(abs);

  const pending = { resolved: null };
  cache.set(
    abs,
    new Proxy(
      {},
      {
        get(_, prop) {
          if (prop === 'default') return (...args) => pending.resolved.default(...args);
          return pending.resolved?.[prop];
        }
      }
    )
  );

  const source = readFileSync(abs, 'utf8');
  const relative = abs.slice(root.length + 1).replace(/\\/g, '/');
  // `.svelte.js` / `.svelte.ts` modules use runes too, and go through
  // `compileModule` rather than the component compiler.
  const { js } = abs.endsWith('.svelte')
    ? compile(source, { filename: relative, dev: true, generate: 'client' })
    : compileModule(source, { filename: relative, dev: true, generate: 'client' });

  const deps = new Map();
  let code = js.code.replace(
    /import\s+([^;'"]+?)\s+from\s+['"](\.[^'"]+)['"];/g,
    (match, clause, spec) => {
      let target = resolve(dirname(abs), spec);
      const alias = `d${cache.size}_${deps.size}`;
      deps.set(alias, target);
      const trimmed = clause.trim();
      if (trimmed.startsWith('*')) {
        return `const ${trimmed.replace(/^\*\s+as\s+/, '')} = globalThis.__deps.${alias};`;
      }
      if (trimmed.startsWith('{')) return `const ${trimmed} = globalThis.__deps.${alias};`;
      return `const ${trimmed} = globalThis.__deps.${alias}.default;`;
    }
  );

  // Let a test install an instrumented runtime namespace, which is how the
  // Tier 2 plugin's push/pop/tag interception is exercised without a bundler.
  //
  // The compiled component assigns `Component[$.FILENAME]` near the top of the
  // module, which can precede the original import statement's position after
  // rewriting. The namespace binding is therefore hoisted to the very start of
  // the file so it is initialised before any component code runs.
  const clientImport = /import\s+\*\s+as\s+(\$\w*)\s+from\s+["']svelte\/internal\/client["'];/;
  const clientMatch = code.match(clientImport);
  if (clientMatch) {
    const binding = clientMatch[1];
    code =
      `import * as __real_client from 'svelte/internal/client';\n` +
      `const ${binding} = new Proxy(__real_client, {\n` +
      `  get: (t, p) => (globalThis.__svelteClientOverride ?? t)[p]\n` +
      `});\n` +
      code.replace(clientImport, '');
  }

  for (const [alias, target] of deps) {
    // Runes are available in `.svelte` components and `.svelte.js` modules, both
    // of which need compiling; anything else is plain JS and imports directly.
    globalThis.__deps[alias] = /\.svelte(\.[jt]s)?$/.test(target)
      ? await loadComponent(target)
      : await import(pathToFileURL(target).href);
  }

  const outDir = join(root, 'node_modules', '.probe');
  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, relative.replace(/[\\/]/g, '_') + '.mjs');
  writeFileSync(outFile, code);

  const mod = await import(pathToFileURL(outFile).href + '?t=' + Date.now());
  pending.resolved = mod;
  cache.set(abs, mod);
  return mod;
}

/** Mounts the playground app and returns the dom plus svelte helpers. */
export async function bootPlayground() {
  const dom = createDom();
  const svelte = await import('svelte');
  const App = (await loadComponent(join(root, 'playground/src/App.svelte'))).default;
  const instance = svelte.mount(App, { target: dom.window.document.getElementById('app') });
  svelte.flushSync();
  return { dom, svelte, instance, document: dom.window.document, window: dom.window };
}
