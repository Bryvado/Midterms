const KEY = 'tx-layout-v1';
const GAP = 12;
const MIN = { w:180, h:90 };
const phone = window.matchMedia('(max-width:700px)');
const workspace = document.querySelector('.workspace');
const panels = new Map([...document.querySelectorAll('.float-panel')].map(el => [el.dataset.panel, el]));
let state = load();
let top = 10;

function load() {
  try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; }
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* storage unavailable: layout still works for this visit */ }
}

// Default positions depend on the current workspace size, so they are computed, not stored.
function defaults() {
  const W = workspace.clientWidth, H = workspace.clientHeight;
  const sideW = Math.min(320, Math.max(260, Math.round(W * .26)));
  // The polling chart is the panel's main element, so it gets a wider default.
  const pollW = Math.min(480, Math.max(sideW, Math.round(W * .34)));
  // Leave room for readable place rows and comparison controls.
  const placeW = Math.max(260, Math.round(W * .25));
  const placeH = Math.max(MIN.h, Math.round(H / 3));
  const pollH = Math.round(Math.min(H * .52, 560));
  return {
    controls:{ x:GAP, y:GAP, w:null, h:null, open:true },
    // Lifted clear of the map's attribution line, which must stay visible.
    legend:{ x:52, y:null, w:250, h:null, open:true, lift:22 },
    display:{ x:Math.max(GAP, W - pollW - 270 - GAP * 2), y:GAP, w:270, h:Math.min(600, H - GAP * 2), open:false },
    polling:{ x:W - pollW - GAP, y:GAP, w:pollW, h:pollH, open:true },
    shifts:{ x:Math.max(GAP, W - 580 - GAP), y:GAP, w:580, h:Math.min(880, H - GAP * 2), open:false },
    scatter:{ x:Math.max(GAP, W - pollW - 460 - GAP * 2), y:GAP, w:460, h:Math.min(560, H - GAP * 2), open:false },
    place:{ x:W - placeW - GAP, y:H - placeH - GAP, w:placeW, h:placeH, open:true },
  };
}

function clamp(el, box) {
  const W = workspace.clientWidth, H = workspace.clientHeight;
  const w = el.offsetWidth, h = el.offsetHeight;
  box.x = Math.min(Math.max(0, box.x), Math.max(0, W - Math.min(w, W)));
  box.y = Math.min(Math.max(0, box.y), Math.max(0, H - Math.min(h, H)));
}

function apply() {
  const base = defaults();
  for (const [id, el] of panels) {
    const box = { ...base[id], ...(state[id] || {}) };
    el.hidden = !box.open;
    document.querySelector(`[data-open-panel="${id}"]`)?.setAttribute('aria-pressed', String(box.open));
    if (phone.matches) { el.removeAttribute('style'); continue; }
    el.style.width = box.w ? `${box.w}px` : '';
    el.style.height = box.h ? `${box.h}px` : '';
    if (box.y == null) {
      // Bottom-anchored until moved, so a legend that grows stays on screen.
      el.style.left = `${box.x}px`;
      el.style.top = '';
      el.style.bottom = `${GAP + (box.lift || 0)}px`;
      continue;
    }
    el.style.bottom = '';
    clamp(el, box);
    el.style.left = `${box.x}px`;
    el.style.top = `${box.y}px`;
  }
}

function update(id, patch) {
  const el = panels.get(id);
  const current = state[id] || {};
  // A panel that is still closed has no measured position yet, so it opens at its default one.
  if (!phone.matches && !('x' in current)) Object.assign(current, el.hidden && defaults()[id]?.y != null ? { x:defaults()[id].x, y:defaults()[id].y } : { x:el.offsetLeft, y:el.offsetTop });
  state[id] = { ...current, ...patch };
  save();
  apply();
  window.dispatchEvent(new CustomEvent('panel-layout', { detail:{ id } }));
}

export function openPanel(id) {
  if (panels.get(id)?.hidden) update(id, { open:true });
  raise(panels.get(id));
}

function raise(el) { if (el) el.style.zIndex = String(++top); }

function track(event, onMove, onEnd) {
  event.preventDefault();
  const move = e => { if (e.pointerId === event.pointerId) onMove(e.clientX - event.clientX, e.clientY - event.clientY); };
  const up = e => {
    if (e.type !== 'blur' && e.pointerId !== event.pointerId) return;
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', up);
    window.removeEventListener('blur', up);
    onEnd();
  };
  event.currentTarget.setPointerCapture(event.pointerId);
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
  window.addEventListener('blur', up);
}

const boxOf = el => ({ x:el.offsetLeft, y:el.offsetTop, w:el.offsetWidth, h:el.offsetHeight });
function resizeBox(box, edge, dx, dy) {
  let left = box.x, right = box.x + box.w, top = box.y, bottom = box.y + box.h;
  if (edge.includes('w')) left = Math.max(0, Math.min(right - MIN.w, left + dx));
  if (edge.includes('e')) right = Math.min(workspace.clientWidth, Math.max(left + MIN.w, right + dx));
  if (edge.includes('n')) top = Math.max(0, Math.min(bottom - MIN.h, top + dy));
  if (edge.includes('s')) bottom = Math.min(workspace.clientHeight, Math.max(top + MIN.h, bottom + dy));
  return { x:left, y:top, w:right - left, h:bottom - top };
}
function preview(el, box) {
  el.style.bottom = '';
  el.style.left = `${box.x}px`; el.style.top = `${box.y}px`;
  el.style.width = `${box.w}px`; el.style.height = `${box.h}px`;
}

for (const [id, el] of panels) {
  const grip = el.querySelector('.fp-head');
  el.querySelector('.fp-resize')?.remove();
  const name = el.getAttribute('aria-label');
  el.addEventListener('pointerdown', () => raise(el));
  el.querySelector('.fp-close').addEventListener('click', () => update(id, { open:false }));
  const mover = el.querySelector('.fp-grip');
  mover.setAttribute('role', 'button');
  mover.tabIndex = 0;
  mover.setAttribute('aria-label', `Move ${name} panel with arrow keys`);
  grip.addEventListener('pointerdown', event => {
    if (phone.matches || event.button !== 0 || event.target.closest('button:not(.fp-grip)')) return;
    const x0 = el.offsetLeft, y0 = el.offsetTop;
    el.style.bottom = '';
    el.style.top = `${y0}px`;
    el.classList.add('dragging');
    track(event, (dx, dy) => { el.style.left = `${x0 + dx}px`; el.style.top = `${y0 + dy}px`; },
      () => { el.classList.remove('dragging'); update(id, { x:el.offsetLeft, y:el.offsetTop }); });
  });
  const keys = { ArrowLeft:[-1,0], ArrowRight:[1,0], ArrowUp:[0,-1], ArrowDown:[0,1] };
  mover.addEventListener('keydown', e => {
    if (!keys[e.key] || phone.matches) return;
    e.preventDefault();
    const [dx, dy] = keys[e.key].map(v => v * (e.shiftKey ? 50 : 10));
    update(id, { x:el.offsetLeft + dx, y:el.offsetTop + dy });
  });
  const edges = { n:'top edge', e:'right edge', s:'bottom edge', w:'left edge', nw:'top-left corner', ne:'top-right corner', sw:'bottom-left corner', se:'bottom-right corner' };
  for (const [edge, label] of Object.entries(edges)) {
    const handle = document.createElement('div');
    handle.className = 'fp-resize'; handle.dataset.edge = edge;
    handle.setAttribute('role', 'button'); handle.tabIndex = 0;
    handle.setAttribute('aria-label', `Resize ${name} from ${label} with arrow keys`);
    el.append(handle);
    handle.addEventListener('pointerdown', event => {
      if (phone.matches || event.button !== 0) return;
      const box = boxOf(el);
      el.classList.add('resizing');
      track(event, (dx, dy) => preview(el, resizeBox(box, edge, dx, dy)), () => {
        el.classList.remove('resizing'); update(id, boxOf(el));
      });
    });
    handle.addEventListener('keydown', e => {
      if (!keys[e.key] || phone.matches) return;
      e.preventDefault();
      const [dx, dy] = keys[e.key].map(v => v * (e.shiftKey ? 50 : 10));
      update(id, resizeBox(boxOf(el), edge, dx, dy));
    });
  }
}

for (const button of document.querySelectorAll('[data-open-panel]')) button.addEventListener('click', () => {
  const id = button.dataset.openPanel;
  if (panels.get(id).hidden) openPanel(id); else update(id, { open:false });
});
document.querySelector('#reset-layout')?.addEventListener('click', () => {
  state = {};
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
  apply();
  window.dispatchEvent(new CustomEvent('panel-layout', { detail:{ id:null } }));
});

let pending = 0;
window.addEventListener('resize', () => { cancelAnimationFrame(pending); pending = requestAnimationFrame(apply); });
phone.addEventListener('change', apply);
apply();
