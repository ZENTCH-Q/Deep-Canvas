// src/main.js
import { state, subscribe, scheduleRender, loadAutosave } from './state.js';
import { makeCamera, renormalizeIfNeeded, whenRenormalized, visibleWorldRect } from './camera.js';
import { render } from './renderer.js';
import { createTool } from './tools/index.js';
import { initUI, getRecentColors, setRecentColors, clearRecentColors } from './ui.js';
import { grid, applyWorkerIndex, rebuildIndex, clearIndex } from './spatial_index.js';
import { saveViewportPNG } from './export.js';
import { removeStroke } from './strokes.js';
import { PanTool } from './tools/pan.js';
import { attachHistory } from './history.js';
import { initGalleryView, showGallery, hideGallery } from './gallery.js';
document.documentElement.setAttribute('data-theme', 'dark');

import {
  listDocs, getDoc, createDoc,
  saveDocFull, renameDoc, deleteDoc
} from './docs.js';

const DPR_CAP = 2.5;

const DEFAULT_UI = {
  tool: 'draw',
  brush: 'pen',
  settings: { color: '#88ccff', size: 6, opacity: 1, fill: false },
  palette: [] // empty “Recent” list
};

const canvas = document.getElementById('c');
const overlay = document.getElementById('navOverlay');
const ctx = canvas.getContext('2d', { alpha: true });
ctx.imageSmoothingEnabled = false;
const camera = makeCamera(1.25, 0, 0);
state._freezing = false;
state._freezeBmp = null;

// DOM refs
const galleryView  = document.getElementById('galleryView');
const dockEl       = document.getElementById('dock');
const toolPropsEl  = document.getElementById('toolProps');
const poseHudEl    = document.getElementById('poseHud');
const backBtn      = document.getElementById('backToGallery');

let currentDocId   = null;
let currentDocName = 'Untitled';
let _pendingSave   = null;

let galleryCtl = null;

function docToItem(d) {
  const w = (d.data?.size?.w) || d.data?.width  || 1600;
  const h = (d.data?.size?.h) || d.data?.height || 1000;
  return { id: d.id, name: d.name || 'Untitled', width: w, height: h, thumb: d.thumb };
}

function initGalleryFromDocs() {
  galleryCtl = initGalleryView({
    getItems() {
      return listDocs().map(docToItem);
    },
    onOpen(id) {
      openDoc(id);
    },
    onRename(id, name) {
      renameDoc(id, name);
    },
    onDelete(id) {
      deleteDoc(id);
    },
    onCreateNew() {
      const created = createDoc('Untitled');
      const d = (typeof created === 'string') ? getDoc(created) : created;
      try {
        const doc = d || created;
        if (doc) {
          doc.data = doc.data || {};
          doc.data.ui = { ...DEFAULT_UI };
          // also ensure a predictable fresh background for new docs
          doc.data.background = { color: '#0f1115', alpha: 1 };
          saveDocFull(doc);
        }
      } catch {}
      // Clear “Recent colors” in local storage so UI shows a fresh list
      clearRecentColors();
      setRecentColors(DEFAULT_UI.palette);
      openDoc(d || created);
    },
    afterReorder(items) {

    }
  });
}

function showCanvasView() {
  hideGallery();
  document.getElementById('canvasContainer').style.display = 'block';
  dockEl?.style && (dockEl.style.display = 'flex');
  toolPropsEl?.style && (toolPropsEl.style.display = '');
  poseHudEl?.style && (poseHudEl.style.display = 'none');
  requestAnimationFrame(fitDockToCanvas);
  requestAnimationFrame(fitDockToCanvas);
}
function showGalleryView() {
  showGallery();
  document.getElementById('canvasContainer').style.display = 'none';
  dockEl?.style && (dockEl.style.display = 'none');
  toolPropsEl?.style && (toolPropsEl.style.display = 'none');
  poseHudEl?.style && (poseHudEl.style.display = 'none');
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
    meta: { modified: Date.now() },
    ui: {
      tool: state.tool,
      brush: state.brush,
      settings: { ...state.settings },          // { color, size, opacity, fill }
      palette: getRecentColors()                // recent colors swatch list
    }
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
      galleryCtl?.update({ id: currentDocId, thumb: dataURL });
    } catch {}
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
  const idAtReturn = currentDocId;

  if (_pendingSave) { try { await _pendingSave; } catch {} }
  _pendingSave = (async () => {
    await saveCurrentDoc({ captureThumb: true });
  })();
  try { await _pendingSave; } finally { _pendingSave = null; }

 const d = getDoc(idAtReturn);
 if (d) {
   const exists = galleryCtl?.list().some(it => it.id === d.id);
   if (!exists) galleryCtl?.add(docToItem(d));
   else galleryCtl?.update({ id: d.id, thumb: d.thumb, name: d.name, width: d.data?.size?.w, height: d.data?.size?.h });
 }

  currentDocId = null;
  showGalleryView();
  galleryCtl?.rerender();
}
backBtn?.addEventListener('click', (e) => { e.preventDefault(); backToGallery(); });

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
  fitDockToCanvas();
  setTimeout(fitDockToCanvas, 0);
  document.fonts?.ready?.then?.(fitDockToCanvas);
}
new ResizeObserver(resize).observe(canvas);
new ResizeObserver(() => fitDockToCanvas()).observe(document.getElementById('canvasContainer') || document.body);
window.addEventListener('resize', fitDockToCanvas);
window.addEventListener('orientationchange', fitDockToCanvas);

// fix(touch): robust pointer normalization + pointer capture
function normalizePointerEvent(e) {
  const r = canvas.getBoundingClientRect();
  const cx = e.clientX - r.left;
  const cy = e.clientY - r.top;
  e.canvasX = cx;
  e.canvasY = cy;
  e.worldX  = (cx - camera.tx) / camera.scale;
  e.worldY  = (cy - camera.ty) / camera.scale;
  return e;
}

// Only let the pan-override tool handle mouse (and the explicit Pan tool).
// Touch/pen should default to drawing unless the user selected the Pan tool.
function shouldSendToPanOverride(e) {
  if (state.tool === 'pan') return true;         // user explicitly chose Pan
  return e.pointerType === 'mouse';              // keep mouse middle-drag etc
}

canvas.addEventListener('pointerdown',  e => {
  normalizePointerEvent(e);
  if (e.pointerType !== 'mouse') e.preventDefault(); // block browser touch behavior just in case
  try { canvas.setPointerCapture(e.pointerId); } catch {}
  if (shouldSendToPanOverride(e)) panOverrideTool.onPointerDown?.(e);
  currentTool.onPointerDown?.(e);
});

canvas.addEventListener('pointermove',  e => {
  normalizePointerEvent(e);
  if (e.pointerType !== 'mouse') e.preventDefault();
  if (shouldSendToPanOverride(e)) panOverrideTool.onPointerMove?.(e);
  currentTool.onPointerMove?.(e);
});

canvas.addEventListener('pointerup',    e => {
  normalizePointerEvent(e);
  if (e.pointerType !== 'mouse') e.preventDefault();
  if (shouldSendToPanOverride(e)) panOverrideTool.onPointerUp?.(e);
  currentTool.onPointerUp?.(e);
  try { canvas.releasePointerCapture(e.pointerId); } catch {}
});

canvas.addEventListener('pointercancel', e => {
  normalizePointerEvent(e);
  if (shouldSendToPanOverride(e)) panOverrideTool.cancel?.(e);
  currentTool.cancel?.(e);
  try { canvas.releasePointerCapture(e.pointerId); } catch {}
});

canvas.addEventListener('lostpointercapture', e => {
  normalizePointerEvent(e);
  panOverrideTool.cancel?.(e);
  currentTool.cancel?.(e);
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

let wheelAccum = 0, wheelPoint = { x:0, y:0 }, wheelRAF = 0;
let wheelIdleTimer = 0;
let lastNavRefresh = 0;
let lastRenormAt = 0;
const RENORM_MIN_GAP = 400; // ms

const NAV_REFRESH_MS = 1_00;
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
  const zoomFactor = Math.pow(1.1, -wheelAccum / 120);
  wheelAccum = 0;

  camera.zoomAround(p, zoomFactor);

  scheduleRender();

  clearTimeout(wheelIdleTimer);
  wheelIdleTimer = setTimeout(() => {
    const now = performance.now();
    let started = false;
    if (now - lastRenormAt > RENORM_MIN_GAP) {
      started = renormalizeIfNeeded(camera, state.strokes, { budgetMs: 4 }, state);
      if (started) { lastRenormAt = now; beginFreeze(); }
    }
    whenRenormalized().then(() => {
      if (started) rebuildIndexAsync();
      applyAdaptiveGridCell();
      endNavSnapshot();
      scheduleRender();
    });
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
  if (e.key === 'Escape' || ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'a')) {
    if (state.selection?.size) {
      e.preventDefault();
      try { state.selection.clear(); } catch {}
      state._marquee = null;
      state._transformActive = false;
      state._hoverHandle = null;
      state._activeHandle = null;
      scheduleRender();
      return;
    }
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

let indexWorker = null;
let indexJobGen = 0;
state._indexBusy = false;
function ensureIndexWorker(){
  if (indexWorker) return indexWorker;
  indexWorker = new Worker(new URL('./workers/spatial_index_worker.js', import.meta.url), { type:'module' });
  indexWorker.onmessage = (ev) => {
    const msg = ev.data || {};
    if (msg.type !== 'rebuilt') return;
    if (typeof msg.gen !== 'number' || msg.gen < indexJobGen) return;
    if (typeof msg.count !== 'number' || msg.count !== state.strokes.length) return;
    applyWorkerIndex(grid, msg, state.strokes);
    state._indexBusy = false; 
    endFreeze();
    scheduleRender();
  };
  return indexWorker;
}
function rebuildIndexAsync(){
  const w = ensureIndexWorker();
  state._indexBusy = true;
  w.postMessage({
    type: 'rebuild',
    gen: ++indexJobGen,
    count: state.strokes.length,
    cell: grid.cell,
    strokes: state.strokes.map(s => ({ bbox: s.bbox }))
  });
}

let _dockFitRAF = 0;
function fitDockToCanvas() {
  if (_dockFitRAF) cancelAnimationFrame(_dockFitRAF);
  _dockFitRAF = requestAnimationFrame(() => {
    const dock = document.getElementById('dock');
    const cont = document.getElementById('canvasContainer');
    if (!dock || !cont) return;

    dock.style.setProperty('--dock-scale', '1');
    const avail = Math.max(320, (cont.clientWidth || window.innerWidth) - 28 * 2);
    const natural = Math.ceil(dock.scrollWidth);
    let scale = Math.min(1, avail / Math.max(1, natural));
    scale = Math.max(0.55, scale); 

    dock.style.setProperty('--dock-scale', String(scale));
    document.documentElement.style.setProperty('--dock-scale', String(scale));

    for (let i = 0; i < 6; i++) {
      const w = Math.ceil(dock.getBoundingClientRect().width);
      if (w <= avail || scale <= 0.55) break;
      scale = Math.max(0.55, scale - 0.02);
      dock.style.setProperty('--dock-scale', String(scale));
      document.documentElement.style.setProperty('--dock-scale', String(scale));
    }
  });
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

let currentToolInstance = null;
let dprInitDone = false;

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
initGalleryFromDocs();
resize();
scheduleRender();
showGalleryView();

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

  if (payload.ui) {
    const u = payload.ui;
    if (u.palette && Array.isArray(u.palette)) {
      setRecentColors(u.palette);
    }
    if (u.settings && typeof u.settings === 'object') {
      state.settings = { ...state.settings, ...u.settings };
    }
    if (u.brush) state.brush = u.brush;
    if (u.tool) setTool(u.tool);
    try {
      const qb = document.getElementById('quickBrush');
      if (qb) qb.value = state.brush;
    } catch {}
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
