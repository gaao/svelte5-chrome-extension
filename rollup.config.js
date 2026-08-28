import { nodeResolve } from '@rollup/plugin-node-resolve';

/**
 * Builds the two extension scripts that must not depend on Svelte:
 *
 *   agent.js      runs in the page's MAIN world, reads `__svelte_meta`
 *   background.js the MV3 service worker
 *
 * Both are emitted into `build/`, alongside the Vite-built panel. Vite's
 * `emptyOutDir` would wipe them, so `npm run build` runs Rollup first and Vite
 * copies nothing over them.
 */
export default [
  {
    input: 'src/agent/index.js',
    output: {
      // Classic IIFE, not ESM: the agent is injected into the inspected page
      // via a <script src> pointing at a chrome-extension:// URL. Module scripts
      // loaded cross-scheme that way are deferred and subject to CORS module
      // fetch rules; a classic script (the approach the Svelte 4 devtools used)
      // executes immediately on insertion.
      file: 'build/agent.js',
      format: 'iife',
      sourcemap: true
    },
    plugins: [nodeResolve()]
  },
  {
    input: 'src/bridge/background.js',
    output: {
      file: 'build/background.js',
      format: 'esm',
      sourcemap: true
    },
    plugins: [nodeResolve()]
  }
];
