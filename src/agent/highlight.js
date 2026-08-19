/**
 * In-page highlight overlay for the selected/hovered node.
 *
 * Boxes are appended to `document.body` and tagged with `data-svelte-devtools`
 * so the mutation observer ignores them.
 *
 * The Svelte 4 devtools positioned boxes by adding `scrollX/scrollY` to
 * `getBoundingClientRect()` and branching on `position: fixed`, which left a
 * `// TODO: handle sticky position` bug where sticky elements were highlighted
 * at the wrong offset. This uses viewport coordinates with `position: fixed`
 * instead, so it is correct for static, absolute, fixed and sticky elements
 * alike, and needs no scroll compensation at all.
 */

const CONTAINER_ID = 'svelte-devtools-highlight';

let container = null;
let raf = 0;
/** @type {{ element: Element, label: string } | null} */
let target = null;

function ensureContainer() {
  if (container && container.isConnected) return container;

  container = document.createElement('div');
  container.id = CONTAINER_ID;
  container.setAttribute('data-svelte-devtools', 'highlight');
  Object.assign(container.style, {
    position: 'fixed',
    inset: '0',
    pointerEvents: 'none',
    zIndex: '2147483647',
    contain: 'strict'
  });

  container.innerHTML = `
    <div data-part="box" style="
      position: fixed;
      background: rgba(255, 62, 0, 0.18);
      border: 1px solid rgba(255, 62, 0, 0.9);
      box-sizing: border-box;
      pointer-events: none;
      display: none;
    "></div>
    <div data-part="label" style="
      position: fixed;
      background: #ff3e00;
      color: #fff;
      font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
      padding: 1px 5px;
      border-radius: 3px;
      white-space: nowrap;
      pointer-events: none;
      display: none;
    "></div>
  `;

  document.body.appendChild(container);
  return container;
}

function draw() {
  raf = 0;
  const root = ensureContainer();
  const box = root.querySelector('[data-part="box"]');
  const label = root.querySelector('[data-part="label"]');

  if (!target || !target.element.isConnected) {
    box.style.display = 'none';
    label.style.display = 'none';
    return;
  }

  const rect = target.element.getBoundingClientRect();

  // Zero-area elements have nothing meaningful to outline.
  if (rect.width === 0 && rect.height === 0) {
    box.style.display = 'none';
    label.style.display = 'none';
    return;
  }

  Object.assign(box.style, {
    display: 'block',
    top: `${rect.top}px`,
    left: `${rect.left}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`
  });

  label.textContent = target.label;
  label.style.display = 'block';

  // Prefer above the element; fall back to inside when there is no room.
  const labelRect = label.getBoundingClientRect();
  const above = rect.top - labelRect.height - 2;
  Object.assign(label.style, {
    top: `${above < 0 ? Math.min(rect.top + 2, window.innerHeight - labelRect.height) : above}px`,
    left: `${Math.max(0, Math.min(rect.left, window.innerWidth - labelRect.width))}px`
  });
}

function schedule() {
  if (raf) return;
  raf = requestAnimationFrame(draw);
}

/** Highlights an element. Pass `null` to clear. */
export function highlight(element, label = '') {
  target = element ? { element, label } : null;
  schedule();

  if (target) {
    // Keep the box glued to the element while the page scrolls or resizes.
    window.addEventListener('scroll', schedule, { passive: true, capture: true });
    window.addEventListener('resize', schedule, { passive: true });
  } else {
    window.removeEventListener('scroll', schedule, { capture: true });
    window.removeEventListener('resize', schedule);
  }
}

export function clearHighlight() {
  highlight(null);
}

/** Removes the overlay entirely. */
export function destroyHighlight() {
  clearHighlight();
  container?.remove();
  container = null;
}
