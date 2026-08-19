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
      file: 'build/agent.js',
      format: 'esm',
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
