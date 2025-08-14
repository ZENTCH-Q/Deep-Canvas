// src/main.js
import { state, subscribe, scheduleRender, loadAutosave } from './state.js';
import { makeCamera, renormalizeIfNeeded, whenRenormalized, visibleWorldRect } from './camera.js';
import { render } from './renderer.js';
import { createTool } from './tools/index.js';
import { initUI } from './ui.js';
import { grid, applyWorkerIndex, rebuildIndex, clearIndex } from './spatial_index.js';
import { saveViewportPNG } from './export.js';
import { removeStroke } from './strokes.js';
import { PanTool } from './tools/pan.js';
import { attachHistory } from './history.js';

import {
  listDocs, getDoc, createDoc,
  saveDocFull, renameDoc, deleteDoc
} from './docs.js';

const DPR_CAP = 2.5;

const canvas = document.getElementById('c');
const overlay = document.getElementById('navOverlay');
const ctx = canvas.getContext('2d', { alpha: true });
ctx.imageSmoothingEnabled = false;
const camera = makeCamera(1.25, 0, 0);
state._freezing = false;
state._freezeBmp = null;
const galleryView  = document.getElementById('galleryView');
const galleryRoot  = document.getElementById('galleryRoot');
const dockEl       = document.getElementById('dock');
const toolPropsEl  = document.getElementById('toolProps');
const poseHudEl    = document.getElementById('poseHud');
const backBtn      = document.getElementById('backToGallery');

let currentDocId   = null;
let currentDocName = 'Untitled';
let _pendingSave   = null; 

function showCanvasView() {
  if (galleryView) galleryView.style.display = 'none';
  document.getElementById('canvasContainer').style.display = 'block';
  dockEl?.style && (dockEl.style.display = 'flex');
  toolPropsEl?.style && (toolPropsEl.style.display = '');
  poseHudEl?.style && (poseHudEl.style.display = 'none');
}
function showGalleryView() {
  document.getElementById('canvasContainer').style.display = 'none';
  dockEl?.style && (dockEl.style.display = 'none');
  toolPropsEl?.style && (toolPropsEl.style.display = 'none');
  poseHudEl?.style && (poseHudEl.style.display = 'none');
  if (galleryView) galleryView.style.display = 'block';
  renderGallery();
}

function blobToDataURL(blob) {
  return new Promise(res => {
    const r = new FileReader();
    r.onload = () => res(String(r.result || ''));
    r.readAsDataURL(blob);
  });
}

function prepareStrokeForSave(s) {
  const out = { ...s };
  delete out._gridKeys;
  delete out._bakeJ;
  delete out._bakeK;
  delete out._lodCache;
  delete out._chunks;
  delete out._baked;

  if (out.kind === 'path') {
    const asObjs = [];
    if (out.n != null && out.pts && typeof out.pts.BYTES_PER_ELEMENT === 'number') {
      const n = Math.max(0, Math.floor(out.n / 3) * 3);
      for (let i = 0; i < n; i += 3) {
        asObjs.push({ x: out.pts[i], y: out.pts[i+1], p: out.pts[i+2] ?? 0.5 });
      }
    } else if (Array.isArray(out.pts) && typeof out.pts[0] === 'number') {
      for (let i = 0; i < out.pts.length; i += 3) {
        asObjs.push({ x: +out.pts[i] || 0, y: +out.pts[i+1] || 0, p: (out.pts[i+2] != null ? +out.pts[i+2] : 0.5) });
      }
    } else if (Array.isArray(out.pts) && out.pts.length && typeof out.pts[0] === 'object') {
      for (const p of out.pts) asObjs.push({ x:+p.x||0, y:+p.y||0, p:(p.p!=null?+p.p:0.5) });
    }
    out.pts = asObjs;
    out.n = null;
  }
  return out;
}

function extractDocDataFromState() {
  return {
    version: 2,
    strokes: state.strokes.map(prepareStrokeForSave),
    background: state.background ? { color: state.background.color, alpha: state.background.alpha } : { color:'#0f1115', alpha:1 },
    meta: { modified: Date.now() }
  };
}

function normalizeLoadedStroke(st) {
  if (!st) return null;
  const s = { ...st, _chunks: null, _baked: true };
  if (!s.bbox) s.bbox = { minx:0, miny:0, maxx:0, maxy:0 };

  if (s.kind === 'path') {
    if (s.n != null && s.pts && typeof s.pts.BYTES_PER_ELEMENT === 'number') {
      const arr = [];
      const n = Math.max(0, Math.floor(s.n / 3) * 3);
      for (let i=0;i<n;i+=3) arr.push({ x:s.pts[i], y:s.pts[i+1], p:s.pts[i+2]??0.5 });
      s.pts = arr; s.n = null;
    } else if (Array.isArray(s.pts) && typeof s.pts[0] === 'number') {
      const arr = [];
      for (let i=0;i<s.pts.length;i+=3) arr.push({ x:+s.pts[i]||0, y:+s.pts[i+1]||0, p:(s.pts[i+2]!=null?+s.pts[i+2]:0.5) });
      s.pts = arr; s.n = null;
    } else if (!Array.isArray(s.pts)) {
      s.pts = [];
      s.n = null;
    } else {
      s.n = null;
    }
  }
  return s;
}

async function saveCurrentDoc({ captureThumb = true } = {}) {
  if (!currentDocId) return;

  const payload = extractDocDataFromState();
  const cam = { s: camera.scale, tx: camera.tx, ty: camera.ty };

  const base = getDoc(currentDocId) || { id: currentDocId, name: currentDocName };
  const doc = { ...base, data: payload, camera: cam, updated: Date.now() };

  if (captureThumb) {
    try {
      const blob = await saveViewportPNG(canvas, ctx, camera, state, 0.65, 1);
      const dataURL = await blobToDataURL(blob);
      doc.thumb = dataURL;
    } catch {
    }
  }

  saveDocFull(doc);
}

let _saveTick = 0;
function scheduleDocAutosave() {
  if (!currentDocId) return;
  const tNow = Date.now();
  if (tNow - _saveTick < 1200) return;
  _saveTick = tNow;
  saveCurrentDoc({ captureThumb:false });
}

async function backToGallery() {
  if (!currentDocId) { showGalleryView(); return; }

  if (_pendingSave) { try { await _pendingSave; } catch {} }
  _pendingSave = (async () => {
    await saveCurrentDoc({ captureThumb: true });
  })();
  try { await _pendingSave; } finally { _pendingSave = null; }

  currentDocId = null;
  showGalleryView();
}

backBtn?.addEventListener('click', (e) => {
  e.preventDefault();
  backToGallery();
});

function focusCardEl(el) { try { el?.focus?.(); } catch {} }

function renderGallery() {
  if (!galleryRoot) return;
  const docs = listDocs();

  const gridEl = document.createElement('div');
  gridEl.className = 'g-grid';

  // New canvas card
  const newBtn = document.createElement('button');
  newBtn.type = 'button';
  newBtn.className = 'g-card g-new';
  newBtn.setAttribute('aria-label','Create new canvas');
  newBtn.innerHTML = `
    <div class="g-thumb plus"><span>＋</span></div>
    <div class="g-meta"><span class="g-name">New Canvas</span></div>
  `;
  newBtn.addEventListener('click', () => {
    const doc = createDoc('Untitled');
    openDoc(doc);
  });
  const newWrap = document.createElement('div');
  newWrap.className = 'g-item';
  newWrap.appendChild(newBtn);
  gridEl.appendChild(newWrap);

  // Existing docs
  for (const d of docs) {
    const wrap = document.createElement('div');
    wrap.className = 'g-item';

    const card = document.createElement('div');
    card.className = 'g-card';
    card.tabIndex = 0;
    card.dataset.id = d.id;

    const thumb = document.createElement('div');
    thumb.className = 'g-thumb' + (d.thumb ? '' : ' no-thumb');
    if (d.thumb) {
      const img = document.createElement('img');
      img.alt = '';
      img.decoding = 'async';
      img.loading = 'lazy';
      img.src = d.thumb;
      thumb.appendChild(img);
    }

    const acts = document.createElement('div');
    acts.className = 'g-actions';
    acts.innerHTML = `
      <button class="g-act g-rename" title="Rename" aria-label="Rename">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M3 21h6"/><path d="M7 17l10-10 3 3-10 10H7v-3z"/></svg>
      </button>
      <button class="g-act g-del" title="Delete" aria-label="Delete">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M3 6h18"/><path d="M8 6v14a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2V6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
      </button>
    `;

    const meta = document.createElement('div');
    meta.className = 'g-meta';
    const nameEl = document.createElement('div');
    nameEl.className = 'g-name';
    nameEl.textContent = d.name || 'Untitled';
    nameEl.title = 'Double-click to rename';
    nameEl.spellcheck = false;
    meta.appendChild(nameEl);

    card.appendChild(thumb);
    card.appendChild(acts);
    card.appendChild(meta);
    wrap.appendChild(card);
    gridEl.appendChild(wrap);
    card.addEventListener('dblclick', (e) => { e.preventDefault(); openDoc(d.id); });
    function startRename() {
      nameEl.setAttribute('contenteditable','true');
      nameEl.focus();
      document.getSelection()?.selectAllChildren?.(nameEl);
    }
    function commitRename() {
      const val = (nameEl.textContent || '').trim() || 'Untitled';
      renameDoc(d.id, val);
      nameEl.removeAttribute('contenteditable');
      renderGallery();
    }
    acts.querySelector('.g-rename')?.addEventListener('click', (e) => { e.stopPropagation(); startRename(); });
    nameEl.addEventListener('dblclick', (e) => { e.stopPropagation(); startRename(); });
    nameEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
      if (e.key === 'Escape') { e.preventDefault(); nameEl.removeAttribute('contenteditable'); nameEl.textContent = d.name || 'Untitled'; }
    });
    nameEl.addEventListener('blur', commitRename);
    acts.querySelector('.g-del')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const sure = confirm(`Delete “${d.name || 'Untitled'}”? This can’t be undone.`);
      if (!sure) return;
      deleteDoc(d.id);
      renderGallery();
    });

    card.addEventListener('keydown', (e) => {
      if ((e.key === 'Backspace' || e.key === 'F2') && document.activeElement === card) {
        e.preventDefault();
        startRename();
        return;
      }
      if (e.key === 'Delete' && document.activeElement === card) {
        e.preventDefault();
        const sure = confirm(`Delete “${d.name || 'Untitled'}”?`);
        if (!sure) return;
        deleteDoc(d.id);
        renderGallery();
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        openDoc(d.id);
      }
    });
  }

  galleryRoot.innerHTML = '';
  galleryRoot.appendChild(gridEl);
  focusCardEl(galleryRoot.querySelector('.g-card'));
}

async function beginFreeze() {
  try {
    state._freezeBmp?.close?.();
    state._freezeBmp = await createImageBitmap(canvas);
    state._freezing = true;
    scheduleRender();
  } catch {}
}
function endFreeze() {
  try { state._freezeBmp?.close?.(); } catch {}
  state._freezeBmp = null;
  state._freezing = false;
  scheduleRender();
}

let indexWorker = null;
let indexJobGen = 0;
function ensureIndexWorker(){
  if (indexWorker) return indexWorker;
  indexWorker = new Worker(new URL('./workers/spatial_index_worker.js', import.meta.url), { type:'module' });
  indexWorker.onmessage = (ev) => {
    const msg = ev.data || {};
    if (msg.type !== 'rebuilt') return;
    if (typeof msg.gen !== 'number' || msg.gen < indexJobGen) return;
    if (typeof msg.count !== 'number' || msg.count !== state.strokes.length) return;
    applyWorkerIndex(grid, msg, state.strokes);
    endFreeze();
    scheduleRender();
  };
  return indexWorker;
}
function rebuildIndexAsync(){
  const w = ensureIndexWorker();
  w.postMessage({
    type: 'rebuild',
    gen: ++indexJobGen,
    count: state.strokes.length,
    cell: grid.cell,
    strokes: state.strokes.map(s => ({ bbox: s.bbox }))
  });
}

let currentTool = createTool(state.tool, { canvas, ctx, overlay, camera, state });
const panOverrideTool = new PanTool({
  canvas, overlay, camera, state,
  onRenormStart: beginFreeze,
  onRenormEnd: () => { rebuildIndexAsync(); }
});

function setTool(name){
  state.tool = name;
  for (const b of document.querySelectorAll('[data-tool]')) {
    b.classList.toggle('active', b.dataset.tool === name);
  }
  currentTool?.cancel?.();
  currentTool = createTool(name, { canvas, ctx, overlay, camera, state });
  scheduleRender();
}

let dpr = 1;
function computeDPR(){ dpr = Math.min(DPR_CAP, Math.max(1, window.devicePixelRatio || 1)); }
function resize(){
  computeDPR();
  canvas.width  = Math.floor(canvas.clientWidth  * dpr);
  canvas.height = Math.floor(canvas.clientHeight * dpr);
  if (overlay){
    overlay.width  = canvas.width;
    overlay.height = canvas.height;
    overlay.style.width  = canvas.clientWidth + 'px';
    overlay.style.height = canvas.clientHeight + 'px';
  }
  scheduleRender();
}
new ResizeObserver(resize).observe(canvas);

canvas.addEventListener('pointerdown', e => { panOverrideTool.onPointerDown?.(e); currentTool.onPointerDown?.(e); });
canvas.addEventListener('pointermove', e => { panOverrideTool.onPointerMove?.(e); currentTool.onPointerMove?.(e); });
canvas.addEventListener('pointerup',    e => { panOverrideTool.onPointerUp?.(e);   currentTool.onPointerUp?.(e); });
canvas.addEventListener('pointercancel',e => { panOverrideTool.cancel?.(e);        currentTool.cancel?.(e); });
canvas.addEventListener('lostpointercapture', e => { panOverrideTool.cancel?.(e); currentTool.cancel?.(e); });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

let wheelAccum = 0, wheelPoint = { x:0, y:0 }, wheelRAF = 0;
let wheelIdleTimer = 0;
let lastNavRefresh = 0;

const NAV_REFRESH_MS = 100;
const WHEEL_IDLE_MS  = 110;

function ensureNavSnapshot() {
  if (state._navActive && (state._navBuf || state._navBmp)) return;

  (async () => {
    try { state._navBmp?.close?.(); } catch {}
    state._navBmp = null;

    try {
      if (typeof OffscreenCanvas !== 'undefined') {
        state._navBuf = new OffscreenCanvas(canvas.width, canvas.height);
      } else {
        const c = document.createElement('canvas');
        c.width = canvas.width; c.height = canvas.height;
        state._navBuf = c;
      }
      state._navBufCtx = state._navBuf.getContext('2d', { alpha: true });
      const bctx = state._navBufCtx;
      bctx.setTransform(1,0,0,1,0,0);
      bctx.clearRect(0,0,state._navBuf.width,state._navBuf.height);
      bctx.drawImage(canvas, 0, 0);
    } catch {
      state._navBuf = null; state._navBufCtx = null;
    }

    state._navActive = true;
    state._navPrimed = !!state._navBuf;
    state._navCam0 = { s: camera.scale, tx: camera.tx, ty: camera.ty };
    lastNavRefresh = performance.now();
    scheduleRender();

    try {
      state._navBmp = await createImageBitmap(canvas);
      scheduleRender();
    } catch {
      state._navBmp = null;
    }
  })();
}
function endNavSnapshot(){
  state._navActive = false;
  state._navPrimed = false;
  try { state._navBmp?.close?.(); } catch {}
  state._navBmp = null;
  state._navBuf = null;
  state._navBufCtx = null;
  state._navCam0 = null;
  lastNavRefresh = 0;
}
function refreshNavBufferNow(){
  if (!state._navBuf || !state._navBufCtx) return;
  render(state, camera, state._navBufCtx, state._navBuf, { dpr: 1, skipSnapshotPath: true, forceTrueComposite: true });
  state._navCam0 = { s: camera.scale, tx: camera.tx, ty: camera.ty };
  state._navPrimed = true;
  try {
    const old = state._navBmp;
    createImageBitmap(state._navBuf).then(bmp => {
      try { old?.close?.(); } catch {}
      state._navBmp = bmp;
      scheduleRender();
    });
  } catch {
    scheduleRender();
  }
}
function applyWheelZoom(){
  wheelRAF = 0;
  if (wheelAccum === 0) return;

  const r = canvas.getBoundingClientRect();
  const p = { x: wheelPoint.x - r.left, y: r.top ? (wheelPoint.y - r.top) : wheelPoint.y };

  const factor = Math.pow(1.1, -wheelAccum / 120);
  wheelAccum = 0;

  camera.zoomAround(p, factor);

  const now = performance.now();
  if (now - lastNavRefresh >= NAV_REFRESH_MS) {
    refreshNavBufferNow();
    lastNavRefresh = now;
  }
  scheduleRender();

  clearTimeout(wheelIdleTimer);
  wheelIdleTimer = setTimeout(() => {
    const started = renormalizeIfNeeded(camera, state.strokes, { budgetMs: 4 }, state);
    if (started) beginFreeze();
    whenRenormalized().then(() => { if (started) rebuildIndexAsync(); });
    applyAdaptiveGridCell();

    endNavSnapshot();
    scheduleRender();
  }, WHEEL_IDLE_MS);
}

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (state._drawingActive || state._erasingActive) return;

  if (!state._navActive) ensureNavSnapshot();

  wheelAccum += e.deltaY;
  wheelPoint.x = e.clientX; wheelPoint.y = e.clientY;
  if (!wheelRAF) wheelRAF = requestAnimationFrame(applyWheelZoom);
}, { passive:false });

window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase()==='z') {
    e.preventDefault(); state.history?.undo(); scheduleDocAutosave(); return;
  }
  if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase()==='y' || (e.shiftKey && e.key.toLowerCase()==='z'))) {
    e.preventDefault(); state.history?.redo(); scheduleDocAutosave(); return;
  }
  if (e.key===' ') canvas.classList.add('panning');
});
window.addEventListener('keyup', (e) => { if (e.key===' ') canvas.classList.remove('panning'); });

function getParams(){
  const hp = new URLSearchParams(location.hash.startsWith('#') ? location.hash.slice(1) : location.hash);
  const qp = new URLSearchParams(location.search);
  return (key) => hp.get(key) ?? qp.get(key);
}
function applyCameraFromURL(){
  const get = getParams();
  const s  = parseFloat(get('s'));
  const tx = parseFloat(get('tx'));
  const ty = parseFloat(get('ty'));
  if (Number.isFinite(s) && Number.isFinite(tx) && Number.isFinite(ty)) {
    camera.scale = s; camera.tx = tx; camera.ty = ty;
    scheduleRender();
  }
}
function applyAdaptiveGridCell(){
  const vw = visibleWorldRect(camera, canvas);
  const worldW = Math.max(16, vw.maxx - vw.minx);
  const target = Math.max(128, Math.min(4096, worldW / 40));
  if (Math.abs(target - grid.cell) / grid.cell > 0.25) {
    grid.cell = target;
    rebuildIndexAsync();
  }
}

const uiAPI = initUI({
  state, canvas, camera,
  setTool,
  onSave: async (scale=1) => {
    const blob = await saveViewportPNG(canvas, ctx, camera, state, scale, dpr);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'endless.png'; a.click();
    URL.revokeObjectURL(url);
  }
});

window._endless = { state, camera, grid };

subscribe(() => {
  const stats = render(state, camera, ctx, canvas, { dpr });
  const hud = document.getElementById('hud');
  if (hud) {
    hud.textContent =
      `strokes:${state.strokes.length} | tool:${state.tool} | brush:${state.brush} | ` +
      `scale:${camera.scale.toExponential(2)} | offset:(${camera.tx|0},${camera.ty|0}) | ` +
      `tiles:${stats.tiles} | vis:${stats.visible}` +
      `${state._freezing ? ' | renorm:freeze' : ''}${state._navActive ? ' | nav:live' : ''}`;
  }
  if (currentDocId) scheduleDocAutosave();
  uiAPI?.updatePoseHud?.();
});

loadAutosave(state);
applyAdaptiveGridCell();
rebuildIndexAsync();
applyCameraFromURL();
window.addEventListener('hashchange', applyCameraFromURL);
attachHistory(state);

const ctxMenu = document.getElementById('ctxMenu');
const ctxResetView = document.getElementById('ctxResetView');
const ctxSavePNG = document.getElementById('ctxSavePNG');
const ctxDeleteSel = document.getElementById('ctxDeleteSel');

function showCtxMenu(x, y){
  if (!ctxMenu) return;
  ctxMenu.style.display = 'block';
  ctxMenu.setAttribute('aria-hidden', 'false');
  const pad = 6;
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const rect = { w: ctxMenu.offsetWidth || 200, h: ctxMenu.offsetHeight || 60 };
  let left = Math.min(x, vw - rect.w - pad);
  let top  = Math.min(y, vh - rect.h - pad);
  if (left < pad) left = pad;
  if (top < pad) top = pad;
  ctxMenu.style.left = left + 'px';
  ctxMenu.style.top  = top  + 'px';
  try {
    const selSize = window._endless?.state?.selection?.size || 0;
    if (ctxDeleteSel) ctxDeleteSel.style.display = selSize > 0 ? 'block' : 'none';
  } catch {}
}
function hideCtxMenu(){
  if (!ctxMenu) return;
  ctxMenu.style.display = 'none';
  ctxMenu.setAttribute('aria-hidden', 'true');
}

canvas.addEventListener('pointerdown', (e) => {
  if (e.button === 2) showCtxMenu(e.clientX, e.clientY);
});
document.addEventListener('pointerdown', (e) => {
  if (!ctxMenu || ctxMenu.style.display === 'none') return;
  const within = ctxMenu.contains(e.target);
  const rightClick = (e.button === 2);
  if (!within && !rightClick) hideCtxMenu();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideCtxMenu(); });
window.addEventListener('resize', hideCtxMenu);
window.addEventListener('scroll', hideCtxMenu, true);

ctxResetView?.addEventListener('click', () => {
  camera.scale = 1.25; camera.tx = 0; camera.ty = 0;
  hideCtxMenu();
  scheduleRender();
});

ctxDeleteSel?.addEventListener('click', () => {
  const st = state;
  const sel = Array.from(st.selection || []);
  if (!sel.length) { hideCtxMenu(); return; }
  const idxs = sel.map(s => st.strokes.indexOf(s));
  for (const s of sel) removeStroke(st, s);
  st.selection.clear();
  st.history?.pushDeleteGroup?.(sel, idxs);
  hideCtxMenu();
});

function strokeHasAnimLayers(st){
  return (st?.react2?.anim?.layers || []).some(l => l && l.enabled && l.type && l.type !== 'none');
}
function strokeHasStyleLayers(st){
  return (st?.react2?.style?.layers || []).some(l => l && l.enabled && l.type && l.type !== 'none');
}
function needsAnimFrame(st){
  if (!st) return false;
  const arr = st.strokes || [];
  for (let i=0;i<arr.length;i++){
    const s = arr[i];
    if (strokeHasAnimLayers(s) || strokeHasStyleLayers(s)) return true;
  }
  return false;
}
(function tick(){
  if (needsAnimFrame(state)) scheduleRender();
  requestAnimationFrame(tick);
})();

ctxSavePNG?.addEventListener('click', async () => {
  const blob = await saveViewportPNG(canvas, ctx, camera, state, 1, dpr);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'endless.png'; a.click();
  URL.revokeObjectURL(url);
  hideCtxMenu();
});

function resetAppStateToBlank() {
  state.strokes.splice(0, state.strokes.length);
  try { state.selection?.clear?.(); } catch {}
  state.undoStack.length = 0;
  state.redoStack.length = 0;

  state.background = { color: '#0f1115', alpha: 1 };
  state.tool = 'draw';
  state.brush = 'pen';
  state.settings = { color: '#88ccff', size: 6, opacity: 1, fill: false };

  clearIndex(grid);
  camera.scale = 1.25; camera.tx = 0; camera.ty = 0;

  scheduleRender();
}

export function openDoc(docOrId) {
  const doc = (typeof docOrId === 'string') ? getDoc(docOrId) : docOrId;
  if (!doc) return;

  currentDocId = doc.id;
  currentDocName = doc.name || 'Untitled';

  resetAppStateToBlank();

  const payload = doc.data || { version:2, strokes:[], background:{ color:'#0f1115', alpha:1 } };

  const fixed = [];
  for (const st of (payload.strokes || [])) {
    const s = normalizeLoadedStroke(st);
    if (s) fixed.push(s);
  }
  state.strokes.splice(0, state.strokes.length, ...fixed);

  if (payload.background && typeof payload.background.color === 'string') {
    const a = Number(payload.background.alpha);
    state.background = { color: payload.background.color, alpha: Number.isFinite(a) ? Math.max(0, Math.min(1, a)) : 1 };
  } else {
    state.background = { color: '#0f1115', alpha: 1 };
  }

  rebuildIndex(grid, state.strokes);

  if (doc.camera) {
    camera.scale = Number.isFinite(doc.camera.s) ? doc.camera.s : 1.25;
    camera.tx    = Number.isFinite(doc.camera.tx) ? doc.camera.tx : 0;
    camera.ty    = Number.isFinite(doc.camera.ty) ? doc.camera.ty : 0;
  } else {
    camera.scale = 1.25; camera.tx = 0; camera.ty = 0;
  }

  showCanvasView();
  scheduleRender();
}

document.addEventListener('keydown', (e) => {
  if (!galleryView || galleryView.style.display === 'none') return;
  const isBack = e.key === 'Backspace';
  const isF2   = e.key === 'F2';
  if ((isBack || isF2) && document.activeElement?.closest?.('#galleryRoot')) {
    e.preventDefault();
    const focusedCard = document.activeElement.closest('.g-card');
    if (!focusedCard) return;
    const nameEl = focusedCard.querySelector('.g-name');
    if (!nameEl) return;
    nameEl.setAttribute('contenteditable','true');
    nameEl.focus();
    document.getSelection()?.selectAllChildren?.(nameEl);
  }
});

resize();          
scheduleRender(); 
showGalleryView();
