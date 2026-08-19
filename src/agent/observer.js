/**
 * Watches the document and reports when the Svelte tree needs rebuilding.
 *
 * Svelte 5 emits no lifecycle events for tooling (upstream issue #11389), so
 * DOM mutation is the only available change signal in Tier 1. Mutations are
 * coalesced through `requestAnimationFrame` because a single state update can
 * produce hundreds of individual records.
 */
export function createObserver(onChange, { root = document } = {}) {
  let frame = 0;
  let pending = false;

  const flush = () => {
    frame = 0;
    if (!pending) return;
    pending = false;
    onChange();
  };

  const schedule = () => {
    pending = true;
    if (frame) return;
    frame =
      typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame(flush)
        : setTimeout(flush, 16);
  };

  const observer = new MutationObserver((records) => {
    // Ignore mutations caused by our own highlight overlay.
    for (const record of records) {
      if (isOurs(record.target)) continue;
      schedule();
      return;
    }
  });

  observer.observe(root.documentElement ?? root, {
    childList: true,
    subtree: true,
    attributes: true,
    characterData: true
  });

  return {
    stop() {
      observer.disconnect();
      if (frame) {
        if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
        else clearTimeout(frame);
      }
    }
  };
}

function isOurs(node) {
  const el = node?.nodeType === 1 ? node : node?.parentElement;
  return !!el?.closest?.('[data-svelte-devtools]');
}
