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
  // The place panel lists many columns when nothing is selected, so it defaults wider.
  const placeW = Math.min(420, Math.max(sideW, Math.round(W * .3)));
  const pollH = Math.round(Math.min(H * .58, 560));
  return {
    controls:{ x:GAP, y:GAP, w:null, h:null, open:true },
    // Lifted clear of the map's attribution line, which must stay visible.
    legend:{ x:52, y:null, w:250, h:null, open:true, lift:22 },
    display:{ x:Math.max(GAP, W - pollW - 270 - GAP * 2), y:GAP, w:270, h:Math.min(600, H - GAP * 2), open:false },
    polling:{ x:W - pollW - GAP, y:GAP, w:pollW, h:pollH, open:true },
    place:{ x:W - placeW - GAP, y:pollH + GAP * 2, w:placeW, h:Math.max(MIN.h, H - pollH - GAP * 3), open:true },
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
  if (!phone.matches && !('x' in current)) Object.assign(current, { x:el.offsetLeft, y:el.offsetTop });
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
  const move = e => onMove(e.clientX - event.clientX, e.clientY - event.clientY);
  const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); onEnd(); };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

for (const [id, el] of panels) {
  const grip = el.querySelector('.fp-head');
  const handle = el.querySelector('.fp-resize');
  const name = el.getAttribute('aria-label');
  el.addEventListener('pointerdown', () => raise(el));
  el.querySelector('.fp-close').addEventListener('click', () => update(id, { open:false }));
  const mover = el.querySelector('.fp-grip');
  mover.setAttribute('role', 'button');
  mover.tabIndex = 0;
  mover.setAttribute('aria-label', `Move ${name} panel with arrow keys`);
  handle.setAttribute('role', 'button');
  handle.tabIndex = 0;
  handle.setAttribute('aria-label', `Resize ${name} panel with arrow keys`);
  grip.addEventListener('pointerdown', event => {
    if (phone.matches || event.button !== 0 || event.target.closest('button:not(.fp-grip)')) return;
    const x0 = el.offsetLeft, y0 = el.offsetTop;
    el.style.bottom = '';
    el.style.top = `${y0}px`;
    el.classList.add('dragging');
    track(event, (dx, dy) => { el.style.left = `${x0 + dx}px`; el.style.top = `${y0 + dy}px`; },
      () => { el.classList.remove('dragging'); update(id, { x:el.offsetLeft, y:el.offsetTop }); });
  });
  handle.addEventListener('pointerdown', event => {
    if (phone.matches || event.button !== 0) return;
    const w0 = el.offsetWidth, h0 = el.offsetHeight;
    track(event, (dx, dy) => { el.style.width = `${Math.max(MIN.w, w0 + dx)}px`; el.style.height = `${Math.max(MIN.h, h0 + dy)}px`; },
      () => update(id, { w:el.offsetWidth, h:el.offsetHeight }));
  });
  const keys = { ArrowLeft:[-1,0], ArrowRight:[1,0], ArrowUp:[0,-1], ArrowDown:[0,1] };
  mover.addEventListener('keydown', e => {
    if (!keys[e.key] || phone.matches) return;
    e.preventDefault();
    const [dx, dy] = keys[e.key].map(v => v * (e.shiftKey ? 50 : 10));
    update(id, { x:el.offsetLeft + dx, y:el.offsetTop + dy });
  });
  handle.addEventListener('keydown', e => {
    if (!keys[e.key] || phone.matches) return;
    e.preventDefault();
    const [dx, dy] = keys[e.key].map(v => v * (e.shiftKey ? 50 : 10));
    update(id, { w:Math.max(MIN.w, el.offsetWidth + dx), h:Math.max(MIN.h, el.offsetHeight + dy) });
  });
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
