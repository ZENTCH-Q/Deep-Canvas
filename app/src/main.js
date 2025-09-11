// src/main.js
import { state, subscribe, scheduleRender, loadAutosave } from './state.js';
import { makeCamera, renormalizeIfNeeded, whenRenormalized, visibleWorldRect } from './camera.js';
import { render } from './renderer.js';
import { createTool } from './tools/index.js';
import { initUI, getRecentColors, setRecentColors, clearRecentColors } from './ui.js';
import { grid, applyWorkerIndex, rebuildIndex, clearIndex } from './spatial_index.js';
import { saveViewportPNG, saveViewportThumb } from './export.js';
import { removeStroke, addShape, selectForTransform } from './strokes.js';
import { selectionBBoxWorld, hitHandle, hitSelectionUI } from './tools/select.js';
import { pointInRect } from './utils/common.js';
import { pickRadius } from './utils/pick.js';
import { pickTopAt } from './utils/picker.js';
import { paintAtPoint } from './tools/paint.js';
import { PanTool } from './tools/pan.js';
import { attachHistory } from './history.js';
import { initGalleryView, showGallery, hideGallery } from './gallery.js';
import { initPlugins } from './plugins.js';
document.documentElement.setAttribute('data-theme', 'dark');

import {
  listDocs, getDoc, createDoc,
  saveDocFull, renameDoc, deleteDoc
} from './docs.js';
import { telemetry } from './utils/telemetry.js';

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
const saveIndicator = document.getElementById('saveIndicator');
const zoomBadge     = document.getElementById('zoomBadge');

let currentDocId   = null;
let currentDocName = 'Untitled';
let _pendingSave   = null;

let galleryCtl = null;

function docToItem(d) {
  // Use document size for consistent card sizes; thumbnail stays centered visually
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
    onDuplicate(id) {
      try {
        const created = createDoc({ duplicateOf: id });
        const doc = (typeof created === 'string') ? getDoc(created) : created;
        if (doc) { galleryCtl?.add(docToItem(doc)); openDoc(doc); }
      } catch {}
    },
    onCreateNew(detail) {
      const bgHex = (typeof detail?.bg === 'string') ? detail.bg : null;
      const name = (typeof detail?.name === 'string') ? detail.name.trim() : 'Untitled';
      const width = Number.isFinite(detail?.w) ? Math.floor(detail.w) : undefined;
      const height = Number.isFinite(detail?.h) ? Math.floor(detail.h) : undefined;
      const created = createDoc({ name, width, height, background: bgHex || '#0f1115' });
      try {
        const doc = (typeof created === 'string') ? getDoc(created) : created;
        if (doc) {
          doc.data = doc.data || {};
          doc.data.ui = { ...DEFAULT_UI };
          saveDocFull(doc);
          // Clear recent colors for a fresh list
          clearRecentColors(); setRecentColors(DEFAULT_UI.palette);
          openDoc(doc);
        }
      } catch { openDoc(created); }
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

// --- Debug pane (Ctrl+Alt+D) ---
function renderDebugPane() {
  const host = document.getElementById('debugPane');
  const pre  = document.getElementById('debugText');
  if (!host || !pre) return;
  const snap = telemetry?.snapshot?.() || {};
  const info = {
    time: new Date().toISOString(),
    state: { dirty: !!state.dirty, strokes: state.strokes.length },
    autosaveKeys: {
      has_next: !!localStorage.getItem('endless_autosave_next'),
      has_cur:  !!localStorage.getItem('endless_autosave'),
      has_prev: !!localStorage.getItem('endless_autosave_prev')
    },
    counters: snap.counters || {},
    last: snap.last || {},
    recent: (snap.recent || []).slice(-10)
  };
  pre.textContent = JSON.stringify(info, null, 2);
}
function toggleDebugPane(force) {
  const host = document.getElementById('debugPane'); if (!host) return;
  const next = (typeof force === 'boolean') ? force : (host.style.display === 'none');
  host.style.display = next ? 'block' : 'none';
  if (next) renderDebugPane();
}
document.getElementById('dbgClose')?.addEventListener('click', () => toggleDebugPane(false));
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey && e.altKey && (e.key === 'd' || e.key === 'D')) {
    e.preventDefault(); toggleDebugPane();
  }
});

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
  // Transient fields (not serializable)
  delete out.img; // HTMLImageElement cache
  delete out.bitmap; // any ImageBitmap cache

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
      const dataURL = await saveViewportThumb(canvas, ctx, camera, state, { maxDim: 640, quality: 0.7, baseDpr: 1 });
      if (dataURL) {
        doc.thumb = dataURL;
        galleryCtl?.update({ id: currentDocId, thumb: dataURL });
      }
    } catch {}
  }

  await saveDocFull(doc);
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
  // End any in-progress interactions and dispose previous tool (important for TextTool listeners)
  currentTool?.cancel?.();
  currentTool?.destroy?.();
  currentTool = createTool(name, { canvas, ctx, overlay, camera, state });
  scheduleRender();
}

// Expose tool switcher so tools (e.g., shapes) can switch to Select
try { state.setTool = setTool; } catch {}

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

  // Auto-calibrate when DPR or canvas size changes significantly vs last calibration
  try {
    const p = state._perf || null;
    if (p) {
      const dprDelta = Math.abs((p.dpr || 1) - dpr);
      const areaPrev = Math.max(1, (p.w || 1) * (p.h || 1));
      const areaNow = Math.max(1, canvas.width * canvas.height);
      const areaRatio = areaNow / areaPrev;
      if (dprDelta > 0.25 || areaRatio > 1.5 || areaRatio < (1/1.5)) {
        scheduleAutoCalibration('resize/dpr_change');
      }
    }
  } catch {}
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

let _exactTimer = 0;
function kickExactIdle(){
  state._renderExact = false;
  if (_exactTimer) { clearTimeout(_exactTimer); _exactTimer = 0; }
  _exactTimer = setTimeout(() => { state._renderExact = true; scheduleRender(); }, 180);
}

canvas.addEventListener('pointerdown',  e => {
  normalizePointerEvent(e);
  if (e.pointerType !== 'mouse') e.preventDefault(); // block browser touch behavior just in case

  // If a non-select tool is active and the user clicks empty space while something
  // is selected, clear the selection box — but DO NOT clear if the click is on
  // selection UI (handles/move/inside box).
  try {
    if (state.tool !== 'select' && state.selection?.size) {
      const world = { x: e.worldX, y: e.worldY };
      const bb = selectionBBoxWorld(state);
      if (bb) {
        const ui = hitSelectionUI(world, state, camera);
        if (!ui) {
          const rWorld = pickRadius(camera, state, 12);
          const hit = pickTopAt(world, rWorld, { camera, state });
          if (!hit) {
            try { state.selection.clear(); } catch {}
            state._marquee = null;
            state._transformActive = false;
            state._hoverHandle = null;
            state._activeHandle = null;
            scheduleRender();
          }
        }
      }
    }
  } catch {}

  try { canvas.setPointerCapture(e.pointerId); } catch {}
  if (shouldSendToPanOverride(e)) panOverrideTool.onPointerDown?.(e);

  // Route transform interactions to the Select tool even if another tool is active
  const selTool = state._selectToolSingleton;
  let routedToSelect = false;
  try {
    if (state.tool !== 'select' && state.selection?.size) {
      const hit = hitSelectionUI({ x: e.worldX, y: e.worldY }, state, camera);
      if (hit && (hit.type === 'handle' || hit.type === 'move' || hit.type === 'inside')) {
        selTool?.onPointerDown?.(e);
        routedToSelect = true;
      }
    }
  } catch {}

  if (!routedToSelect) currentTool.onPointerDown?.(e);
  kickExactIdle();
});

canvas.addEventListener('pointermove',  e => {
  normalizePointerEvent(e);
  if (e.pointerType !== 'mouse') e.preventDefault();
  if (shouldSendToPanOverride(e)) panOverrideTool.onPointerMove?.(e);

  // Always allow Select tool to manage hover/cursor over selection UI
  try { state._selectToolSingleton?.onPointerMove?.(e); } catch {}

  // If in an active transform, keep routing moves to Select tool
  if (state._transformActive) {
    // Already invoked above; nothing else to do for current tool while transforming
  } else {
    currentTool.onPointerMove?.(e);
  }
  kickExactIdle();
});

canvas.addEventListener('pointerup',    e => {
  normalizePointerEvent(e);
  if (e.pointerType !== 'mouse') e.preventDefault();
  if (shouldSendToPanOverride(e)) panOverrideTool.onPointerUp?.(e);

  // If a transform is active, finish it via Select tool
  if (state._transformActive) {
    try { state._selectToolSingleton?.onPointerUp?.(e); } catch {}
  } else {
    currentTool.onPointerUp?.(e);
  }
  try { canvas.releasePointerCapture(e.pointerId); } catch {}
  kickExactIdle();
});

canvas.addEventListener('pointercancel', e => {
  normalizePointerEvent(e);
  if (shouldSendToPanOverride(e)) panOverrideTool.cancel?.(e);
  currentTool.cancel?.(e);
  try { canvas.releasePointerCapture(e.pointerId); } catch {}
  kickExactIdle();
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
    state._navAllowLive = true;  // allow live rendering (animations) during nav
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
  state._navAllowLive = false;
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
  const p = { x: wheelPoint.x - r.left, y: wheelPoint.y - r.top };
  let zoomFactor = Math.pow(1.1, -wheelAccum / 120);
  wheelAccum = 0;

  // Device-aware soft caps with gentle friction near bounds
  const perf = state._perf || {};
  const base = Math.max(1.0, perf.simplifyDisableAtScale || 1.25);
  let maxScale = Math.min(256, base * 4);
  let minScale = Math.max(1/128, 1 / (base * 64));
  if (perf.unlockExtreme) { maxScale = 1e6; minScale = 1e-6; }

  // Friction: reduce zoom step as we approach caps (within 10%)
  const scale = camera.scale;
  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  const smooth = (t) => (t*t*(3 - 2*t));
  const upProx  = clamp01((scale - maxScale * 0.9) / (maxScale * 0.1));   // 0..1 as we near max
  const dnProx  = clamp01((minScale * 1.1 - scale) / (minScale * 0.1));  // 0..1 as we near min
  if (zoomFactor > 1) {
    const k = 1 - smooth(upProx);
    zoomFactor = 1 + (zoomFactor - 1) * k;
  } else if (zoomFactor < 1) {
    const k = 1 - smooth(dnProx);
    zoomFactor = 1 + (zoomFactor - 1) * k;
  }

  camera.zoomAround(p, zoomFactor, minScale, maxScale);

  scheduleRender();
  try { showZoomBadge(); } catch {}

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
  kickExactIdle();
}, { passive:false });

window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase()==='z') {
    e.preventDefault(); state.history?.undo(); scheduleDocAutosave(); return;
  }
  if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase()==='y' || (e.shiftKey && e.key.toLowerCase()==='z'))) {
    e.preventDefault(); state.history?.redo(); scheduleDocAutosave(); return;
  }
  if (e.key === ' ' && !e.repeat) {
    const tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : '';
    const isTyping = tag === 'input' || tag === 'textarea' || (e.target && e.target.isContentEditable);
    if (!isTyping) {
      e.preventDefault();
      state._anim = state._anim || { t: 0, playing: true };
      state._anim.playing = !state._anim.playing;
      scheduleRender();
    }
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

// --- Zoom helpers & badges --------------------------------------------------
let _zoomTimer = 0;
function showZoomBadge(){
  if (!zoomBadge) return;
  try {
    const pct = Math.round((camera.scale || 1) * 100);
    zoomBadge.textContent = `${pct}%`;
    const r = (document.getElementById('dock') || canvas).getBoundingClientRect();
    zoomBadge.style.left = ((r.left + r.right)/2) + 'px';
    zoomBadge.style.top  = (r.top - 12) + 'px';
    zoomBadge.style.display = 'block';
    clearTimeout(_zoomTimer);
    _zoomTimer = setTimeout(()=>{ if (zoomBadge) zoomBadge.style.display = 'none'; }, 1000);
  } catch {}
}

function contentBounds(){
  let minx=Infinity,miny=Infinity,maxx=-Infinity,maxy=-Infinity;
  for (const s of state.strokes){ const b=s?.bbox; if(!b) continue; if(b.minx<minx)minx=b.minx; if(b.miny<miny)miny=b.miny; if(b.maxx>maxx)maxx=b.maxx; if(b.maxy>maxy)maxy=b.maxy; }
  if (!Number.isFinite(minx)){
    const sz = state._docSize || { w:1600, h:1000 };
    return { minx:0, miny:0, maxx:sz.w, maxy:sz.h };
  }
  return { minx, miny, maxx, maxy };
}
function fitToBounds(b){
  if (!b) return;
  const cw = Math.max(1, canvas.clientWidth|0);
  const ch = Math.max(1, canvas.clientHeight|0);
  const w = Math.max(1, b.maxx - b.minx);
  const h = Math.max(1, b.maxy - b.miny);
  const pad = 0.90;
  const scale = pad * Math.min(cw / w, ch / h);
  const cx = (b.minx + b.maxx) * 0.5;
  const cy = (b.miny + b.maxy) * 0.5;
  camera.scale = Math.max(1e-6, scale);
  camera.tx = (cw * 0.5) - camera.scale * cx;
  camera.ty = (ch * 0.5) - camera.scale * cy;
  camera.setHome(camera.scale, camera.tx, camera.ty);
  scheduleRender();
  showZoomBadge();
}
function fitToContent(){ fitToBounds(contentBounds()); }

function getParams(){
  const hp = new URLSearchParams(location.hash.startsWith('#') ? location.hash.slice(1) : location.hash);
  const qp = new URLSearchParams(location.search);
  return (key) => hp.get(key) ?? qp.get(key);
}

// Global hotkeys for fit/zoom/help
function onGlobalHotkeys(e){
  const tag = (e.target && e.target.tagName) ? e.target.tagName.toLowerCase() : '';
  const isTyping = tag === 'input' || tag === 'textarea' || (e.target && e.target.isContentEditable);
  if (isTyping) return;

  const k = e.key;
  if (k && typeof k === 'string'){
    const lower = k.toLowerCase();
    if (lower === 'f'){ e.preventDefault(); fitToContent(); return; }
    if (k === '1' || k === '2' || k === '3'){
      e.preventDefault();
      const target = (k === '1') ? 1 : (k === '2') ? 2 : 3;
      const center = { x: canvas.clientWidth/2, y: canvas.clientHeight/2 };
      const factor = Math.max(1e-6, target / Math.max(1e-6, camera.scale));
      camera.zoomAround(center, factor);
      scheduleRender(); showZoomBadge();
      return;
    }
    if (k === '?' || (e.shiftKey && k === '/')){ e.preventDefault(); toggleHelpOverlay(); return; }
  }
}
window.addEventListener('keydown', onGlobalHotkeys);

// Saving indicator + toasts
let _savedTimer = 0;
function setSaveIndicator(text, cls){
  if (!saveIndicator) return;
  saveIndicator.textContent = text || '';
  saveIndicator.style.display = text ? 'inline-flex' : 'none';
  if (cls) saveIndicator.setAttribute('data-state', cls); else saveIndicator.removeAttribute('data-state');
}
function showToast(msg){
  const host = document.getElementById('toastHost'); if (!host) return;
  const n = document.createElement('div'); n.className = 'toast'; n.textContent = String(msg||'');
  host.appendChild(n);
  requestAnimationFrame(()=>{ n.classList.add('show'); });
  setTimeout(()=>{ n.classList.remove('show'); setTimeout(()=>{ if(n.parentNode) host.removeChild(n); }, 200); }, 2200);
}
document.addEventListener('docs:save:begin', ()=>{ clearTimeout(_savedTimer); setSaveIndicator('Saving…', 'saving'); });
document.addEventListener('docs:save:end', ()=>{
  setSaveIndicator('Saved', 'ok');
  clearTimeout(_savedTimer);
  _savedTimer = setTimeout(()=> setSaveIndicator('', ''), 1200);
});
document.addEventListener('docs:save:error', ()=>{ setSaveIndicator('Save failed', 'err'); showToast('Storage full or unavailable. Thumbnail was dropped to save space.'); });

function toggleHelpOverlay(force){
  const pane = document.getElementById('helpOverlay'); if (!pane) return;
  const next = (typeof force === 'boolean') ? force : (pane.style.display !== 'block');
  pane.style.display = next ? 'block' : 'none';
}
function applyCameraFromURL(){
  const get = getParams();
  const s  = parseFloat(get('s'));
  const tx = parseFloat(get('tx'));
  const ty = parseFloat(get('ty'));
  if (Number.isFinite(s) && Number.isFinite(tx) && Number.isFinite(ty)) {
    camera.scale = s; camera.tx = tx; camera.ty = ty;
    camera.setHome(s, tx, ty);
    try { camera.setDocHome(s, tx, ty); } catch {}
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
  indexWorker = new Worker(new URL('./workers/spatial_index_worker.js', import.meta.url) /* no type:'module' */)
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

// --- Proximity fade for the tool dock ---------------------------------------
const DOCK_FADE = {
  nearPx: 110,       // <= this distance from the dock ⇒ 100% opacity
  farPx: 260,        // >= this distance from the dock ⇒ minOpacity
  minOpacity: 0.0,  // how transparent when far
  idleMs: 1600       // fade after no mouse movement for this long
};

let _dockFadeRAF = 0;
let _dockIdleTimer = 0;
let _lastMouse = { x: -1, y: -1 };

function setDockOpacity(op) {
  if (!dockEl) return;
  const clamped = Math.max(DOCK_FADE.minOpacity, Math.min(1, op));
  dockEl.style.opacity = String(clamped);
  // Avoid stray clicks when very transparent
  dockEl.style.pointerEvents = clamped < 0.25 ? 'none' : 'auto';
}

function distanceFromPointToRect(px, py, r) {
  const dx = (px < r.left) ? (r.left - px) : (px > r.right ? px - r.right : 0);
  const dy = (py < r.top)  ? (r.top  - py) : (py > r.bottom ? py - r.bottom : 0);
  return Math.hypot(dx, dy);
}

function computeDockOpacity() {
  if (!dockEl) return;
  // If on touch / coarse pointer, keep fully visible
  if (window.matchMedia && window.matchMedia('(any-pointer: coarse)').matches) {
    setDockOpacity(1);
    return;
  }
  // If dock is hidden (gallery view), keep visible baseline
  if (dockEl.style.display === 'none') {
    setDockOpacity(1);
    return;
  }
  const rect = dockEl.getBoundingClientRect();
  const d = distanceFromPointToRect(_lastMouse.x, _lastMouse.y, rect);
  let nextOpacity;
  if (d <= DOCK_FADE.nearPx) {
    nextOpacity = 1;
  } else if (d >= DOCK_FADE.farPx) {
    nextOpacity = DOCK_FADE.minOpacity;
  } else {
    // linear interpolate between near (1) and far (minOpacity)
    const t = (d - DOCK_FADE.nearPx) / (DOCK_FADE.farPx - DOCK_FADE.nearPx);
    nextOpacity = 1 - t * (1 - DOCK_FADE.minOpacity);
  }
  setDockOpacity(nextOpacity);
}

function scheduleDockOpacityRecalc() {
  if (_dockFadeRAF) return;
  _dockFadeRAF = requestAnimationFrame(() => {
    _dockFadeRAF = 0;
    computeDockOpacity();
  });
}

function initDockProximityFade() {
  // Ensure a smooth transition even without CSS changes
  try { dockEl.style.transition = 'opacity 180ms ease'; } catch {}
  setDockOpacity(1); // start visible

  document.addEventListener('mousemove', (e) => {
    _lastMouse.x = e.clientX;
    _lastMouse.y = e.clientY;
    scheduleDockOpacityRecalc();
    clearTimeout(_dockIdleTimer);
    _dockIdleTimer = setTimeout(() => setDockOpacity(DOCK_FADE.minOpacity), DOCK_FADE.idleMs);
  });

  // Force-visible when user approaches or focuses the dock
  dockEl?.addEventListener('mouseenter', () => setDockOpacity(1));
  dockEl?.addEventListener('focusin', () => setDockOpacity(1));

  // Keep visible when window loses focus to avoid surprises
  window.addEventListener('blur', () => setDockOpacity(1));
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
initPlugins();

subscribe(() => {
  const stats = render(state, camera, ctx, canvas, { dpr });
  const hud = document.getElementById('hud');
  if (hud) {
    hud.textContent =
      `strokes:${state.strokes.length} | tool:${state.tool} | brush:${state.brush} | ` +
      `scale:${camera.scale.toExponential(2)} | offset:(${camera.tx|0},${camera.ty|0}) | ` +
      `tiles:${stats.tiles} | vis:${stats.visible}` +
      ` | anim:${state._anim?.playing ? '▶' : '⏸'}` +
      `${state._freezing ? ' | renorm:freeze' : ''}${state._navActive ? ' | nav:live' : ''}`;
  }
  if (currentDocId) scheduleDocAutosave();
  uiAPI?.updatePoseHud?.();
});

loadAutosave(state);
const loadedProfile = loadPerfProfile();
if (loadedProfile && !state._perfBase) {
  state._perfBase = { simplifyDisableAtScale: loadedProfile.simplifyDisableAtScale || 1.25, lodPxTol: loadedProfile.lodPxTol || 0.3 };
}
createAdvPane();
ensureAdvancedItem();
if (!loadedProfile) {
  // First run: auto-calibrate shortly after UI becomes responsive
  setTimeout(() => scheduleAutoCalibration('first_run'), 1200);
}
applyAdaptiveGridCell();
rebuildIndexAsync();
applyCameraFromURL();
window.addEventListener('hashchange', applyCameraFromURL);
attachHistory(state);
initGalleryFromDocs();
resize();
scheduleRender();
showGalleryView();

initDockProximityFade();

const ctxMenu = document.getElementById('ctxMenu');
const ctxResetView = document.getElementById('ctxResetView');
const ctxSavePNG = document.getElementById('ctxSavePNG');
const ctxDeleteSel = document.getElementById('ctxDeleteSel');
const ctxCreate = document.getElementById('ctxCreate');
const ctxCreateMenu = document.getElementById('ctxCreateMenu');
const ctxCreateImage = document.getElementById('ctxCreateImage');

let _lastCtxClient = { x: 0, y: 0 };
function showCtxMenu(x, y){
  if (!ctxMenu) return;
  hideCreateSubmenu();
  _lastCtxClient = { x, y };
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
  hideCreateSubmenu();
}

canvas.addEventListener('pointerdown', (e) => {
  if (e.button === 2) showCtxMenu(e.clientX, e.clientY);
});
document.addEventListener('pointerdown', (e) => {
  if (!ctxMenu || ctxMenu.style.display === 'none') return;
  const within = ctxMenu.contains(e.target) || (ctxCreateMenu?.contains?.(e.target) ?? false);
  const rightClick = (e.button === 2);
  if (!within && !rightClick) hideCtxMenu();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideCtxMenu(); });
window.addEventListener('resize', hideCtxMenu);
window.addEventListener('scroll', hideCtxMenu, true);

ctxResetView?.addEventListener('click', async () => {
  try {
    // If a renormalization bake is running, wait for it to finish to avoid visual glitches
    await whenRenormalized();
  } catch {}
  // End any navigation snapshot mode before resetting view
  try { endNavSnapshot(); } catch {}
  // Reset to immutable doc home for consistent result
  try { camera.resetToDocHome(); } catch { camera.resetToHome(); }
  // Force exact render after reset
  state._renderExact = true;
  hideCtxMenu();
  scheduleRender();
});

ctxDeleteSel?.addEventListener('click', () => {
  const st = state;
  let sel = Array.from(st.selection || []);
  // If nothing is selected, but a text is actively being edited, target it
  if (!sel.length) {
    const editingText = st.strokes.find(s => s && s.shape === 'text' && s.editing);
    if (editingText) sel = [editingText];
  }
  if (!sel.length) { hideCtxMenu(); return; }
  const removed = [];
  const indices = [];
  for (const s of sel) {
    // If selection contains a different object instance, resolve by id
    let i = st.strokes.indexOf(s);
    if (i === -1 && s && s.id != null) {
      i = st.strokes.findIndex(t => t && t.id === s.id);
    }
    if (i !== -1) {
      const target = st.strokes[i];
      try { if (target.shape === 'text') target.editing = false; } catch {}
      removeStroke(st, target);
      removed.push(target);
      indices.push(i);
    }
  }
  try { st.selection.clear(); } catch {}
  if (removed.length) st.history?.pushDeleteGroup?.(removed, indices);
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

// --- Create submenu ------------------------------------------------------------
function showCreateSubmenu(){
  if (!ctxCreate || !ctxCreateMenu) return;
  // Position to the right of the Create item
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const pad = 6;
  const itemRect = ctxCreate.getBoundingClientRect();
  // Ensure submenu is rendered to measure
  ctxCreateMenu.style.display = 'block';
  ctxCreateMenu.setAttribute('aria-hidden','false');
  ctxCreate?.setAttribute('aria-expanded','true');
  const w = ctxCreateMenu.offsetWidth || 200;
  const h = ctxCreateMenu.offsetHeight || 40;
  let left = Math.min(itemRect.right + pad, vw - w - pad);
  let top  = Math.min(itemRect.top, vh - h - pad);
  if (left < pad) left = pad;
  if (top < pad) top = pad;
  ctxCreateMenu.style.left = left + 'px';
  ctxCreateMenu.style.top  = top  + 'px';
}
function hideCreateSubmenu(){
  if (!ctxCreateMenu) return;
  ctxCreateMenu.style.display = 'none';
  ctxCreateMenu.setAttribute('aria-hidden','true');
  ctxCreate?.setAttribute('aria-expanded','false');
}

ctxCreate?.addEventListener('mouseenter', showCreateSubmenu);
ctxCreate?.addEventListener('click', (e) => { e.stopPropagation(); showCreateSubmenu(); });
window.addEventListener('resize', hideCreateSubmenu);
window.addEventListener('scroll', hideCreateSubmenu, true);

ctxCreateImage?.addEventListener('click', () => {
  // Use the existing drop handler logic by creating a transient file input
  const input = document.createElement('input');
  input.type = 'file'; input.accept = 'image/*';
  input.style.display = 'none';
  document.body.appendChild(input);
  input.addEventListener('change', () => {
    try {
      const file = input.files && input.files[0];
      if (file) handleDroppedImage(file, _lastCtxClient.x, _lastCtxClient.y);
    } finally {
      document.body.removeChild(input);
      hideCtxMenu();
    }
  }, { once: true });
  input.click();
});

// --- Drag & Drop Images -----------------------------------------------------
function handleDroppedImage(file, clientX, clientY) {
  if (!file || !file.type || !file.type.startsWith('image/')) return;
  const reader = new FileReader();
  reader.onload = () => {
    const dataURL = String(reader.result || '');
    if (!dataURL) return;

    const img = new Image();
    img.onload = () => {
      try {
        const r = canvas.getBoundingClientRect();
        const cx = clientX - r.left;
        const cy = clientY - r.top;
        const world = camera.screenToWorld({ x: cx, y: cy });

        // Use natural pixel size in world units (1 world unit ~= 1 px at scale 1)
        let w = Math.max(1, img.naturalWidth || img.width || 1);
        let h = Math.max(1, img.naturalHeight || img.height || 1);

        // Scale down huge images to a sane max in view (optional)
        try {
          const vw = visibleWorldRect(camera, canvas);
          const maxW = Math.max(64, (vw.maxx - vw.minx) * 0.6);
          const maxH = Math.max(64, (vw.maxy - vw.miny) * 0.6);
          const k = Math.min(1, Math.min(maxW / w, maxH / h));
          w = Math.max(1, Math.floor(w * k));
          h = Math.max(1, Math.floor(h * k));
        } catch {}

        const start = { x: world.x - w / 2, y: world.y - h / 2 };
        const end   = { x: world.x + w / 2, y: world.y + h / 2 };

        const s = addShape(state, {
          shape: 'image',
          brush: state.brush,
          color: state.settings?.color || '#88ccff',
          alpha: state.settings?.opacity ?? 1,
          w: state.settings?.size ?? 6,
          start,
          end,
          fill: false,
          // custom fields for image shape
          src: dataURL,
          rotation: 0,
          naturalW: img.naturalWidth || img.width || w,
          naturalH: img.naturalHeight || img.height || h
        });
        // Store a transient image handle (not persisted)
        try { s.img = img; } catch {}
        // Select for quick transform if desired
        try { selectForTransform(state, s); } catch {}
        // Switch to Select tool so user can move/scale/rotate
        try { setTool('select'); } catch {}
      } catch {}
    };
    img.onerror = () => {};
    try { img.decoding = 'async'; } catch {}
    img.src = dataURL;
  };
  reader.readAsDataURL(file);
}

function installImageDragDrop() {
  const host = document.getElementById('canvasContainer') || canvas;
  if (!host) return;
  const prevent = (e) => { e.preventDefault(); };
  host.addEventListener('dragenter', prevent);
  host.addEventListener('dragover', prevent);
  host.addEventListener('drop', (e) => {
    e.preventDefault();
    const dt = e.dataTransfer;
    if (!dt) return;
    if (dt.files && dt.files.length) {
      for (const f of dt.files) handleDroppedImage(f, e.clientX, e.clientY);
      return;
    }
    // Fallback: URL string
    const uri = dt.getData('text/uri-list') || dt.getData('text/plain');
    if (uri && /^https?:\/\//i.test(uri)) {
      // Try fetch, then convert to blob -> dataURL
      (async () => {
        try {
          const res = await fetch(uri, { mode: 'cors' });
          const blob = await res.blob();
          const file = new File([blob], 'image', { type: blob.type || 'image/png' });
          handleDroppedImage(file, e.clientX, e.clientY);
        } catch {}
      })();
    }
  });
}

installImageDragDrop();

// --- Drag-paint from color panel (drop-to-paint only) --------------------
function isColorDrag(ev){
  try { if (window._dragPaint) return true; } catch {}
  try { return !!ev.dataTransfer?.getData('application/x-color'); } catch { return false; }
}
function endDragPaint(){ try { window._dragPaint = null; } catch {} }

const dHost = document.getElementById('canvasContainer') || canvas;
let _fillRevealActive = false;
function animateRadialReveal(prevBmp, clientX, clientY, durMs = 900){
  try{
    if (!overlay || !prevBmp) return;
    const rect = canvas.getBoundingClientRect();
    const s = Math.max(1e-6, canvas.width / Math.max(1, canvas.clientWidth));
    const cx = (clientX - rect.left) * s;
    const cy = (clientY - rect.top) * s;
    const w = canvas.width, h = canvas.height;
    const corners = [ [0,0], [w,0], [0,h], [w,h] ];
    let maxR = 0; for (const c of corners){ const dx=c[0]-cx, dy=c[1]-cy; const r=Math.hypot(dx,dy); if (r>maxR) maxR=r; }
    const ctxO = overlay.getContext('2d', { alpha: true });
    _fillRevealActive = true;
    overlay.style.display = 'block';
    const t0 = performance.now();
    function step(){
      if (!_fillRevealActive) return;
      const t = (performance.now() - t0) / Math.max(1, durMs);
      const ease = t<0?0:(t>1?1:(1 - Math.pow(1 - t, 3))); // easeOutCubic
      const r = maxR * ease;
      ctxO.setTransform(1,0,0,1,0,0);
      ctxO.clearRect(0,0,w,h);
      // Draw previous snapshot fully, then punch a hole to reveal new paint
      ctxO.globalCompositeOperation = 'source-over';
      ctxO.drawImage(prevBmp, 0, 0);
      ctxO.globalCompositeOperation = 'destination-out';
      ctxO.beginPath(); ctxO.arc(cx, cy, r, 0, Math.PI*2); ctxO.closePath(); ctxO.fill();
      ctxO.globalCompositeOperation = 'source-over';
      if (t < 1) requestAnimationFrame(step); else { _fillRevealActive = false; overlay.style.display = 'none'; try{ prevBmp.close?.(); }catch{} }
    }
    requestAnimationFrame(step);
  }catch{}
}
if (dHost){
  const prevent = (e) => { if (isColorDrag(e)) { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'copy'; } };
  dHost.addEventListener('dragenter', (e)=>{ if (isColorDrag(e)) { prevent(e); } });
  dHost.addEventListener('dragover',  (e)=>{ if (isColorDrag(e)) { prevent(e); } });
  dHost.addEventListener('drop',      async (e)=>{
    if (isColorDrag(e)) {
      prevent(e);
      try {
        // Hide color panel UI immediately on drop
        try { const cp = document.getElementById('colorPanel'); if (cp){ cp.classList.remove('open'); cp.style.display='none'; } } catch {}
        const prevBmp = await createImageBitmap(canvas);
        const payload = (function(){ try { return window._dragPaint || {}; } catch { return {}; } })();
        const prevColor = state.settings?.color;
        const prevOpacity = state.settings?.opacity;
        if (payload.color) state.settings.color = payload.color;
        if (payload.opacity != null) state.settings.opacity = payload.opacity;
        paintAtPoint({ canvas, camera, state }, { clientX: e.clientX, clientY: e.clientY });
        // restore user settings
        if (prevColor != null) state.settings.color = prevColor;
        if (prevOpacity != null) state.settings.opacity = prevOpacity;
        animateRadialReveal(prevBmp, e.clientX, e.clientY, 900);
      } catch {}
      endDragPaint();
    }
  });
  dHost.addEventListener('dragleave', (e)=>{ if (isColorDrag(e)) { prevent(e); } });
}
window.addEventListener('dragend', endDragPaint);

// --- Advanced settings ------------------------------------------------------
function persistPerfProfile() {
  try { localStorage.setItem('dc_perf_profile', JSON.stringify(state._perf)); } catch {}
}

function applyPerfMode(mode) {
  const p = state._perf || {};
  // Establish a base on first use (derived from current profile)
  if (!state._perfBase) state._perfBase = { simplifyDisableAtScale: p.simplifyDisableAtScale || 1.25, lodPxTol: p.lodPxTol || 0.3 };
  const base = state._perfBase;
  let next = { ...p, mode };
  if (mode === 'performance') {
    next.lodPxTol = Math.min(0.8, Math.max(base.lodPxTol, 0.5));
    next.simplifyDisableAtScale = Math.max(1.25, base.simplifyDisableAtScale * 0.5);
  } else if (mode === 'quality') {
    next.lodPxTol = Math.max(0.2, base.lodPxTol * 0.6);
    next.simplifyDisableAtScale = Math.min(512, base.simplifyDisableAtScale * 2);
  } else { // balanced
    next.lodPxTol = base.lodPxTol;
    next.simplifyDisableAtScale = base.simplifyDisableAtScale;
  }
  state._perf = next;
  persistPerfProfile();
  scheduleRender();
}

function createAdvPane() {
  if (document.getElementById('advOverlay')) return;
  const overlay = document.createElement('div');
  overlay.id = 'advOverlay';
  overlay.style.cssText = 'position:fixed;inset:0;display:none;background:rgba(0,0,0,.35);z-index:10000';
  const pane = document.createElement('div');
  pane.id = 'advPane';
  pane.style.cssText = 'position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);min-width:320px;max-width:90vw;padding:14px 16px;border-radius:12px;background:var(--glass, #151a21cc);border:1px solid var(--border, #2a313c);box-shadow:0 18px 44px rgba(0,0,0,.35);color:var(--text,#e7ebf3)';
  pane.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px">
      <strong>Advanced Settings</strong>
      <button id="advClose" class="btn" style="padding:4px 10px">Close</button>
    </div>
    <div style="display:flex;flex-direction:column;gap:12px">
      <div>
        <div style="font:600 12px system-ui;opacity:.8;margin-bottom:6px">Rendering Mode</div>
        <label style="display:flex;gap:6px;align-items:center;margin:4px 0"><input type="radio" name="advMode" value="performance"> Performance (faster)</label>
        <label style="display:flex;gap:6px;align-items:center;margin:4px 0"><input type="radio" name="advMode" value="balanced"> Balanced (default)</label>
        <label style="display:flex;gap:6px;align-items:center;margin:4px 0"><input type="radio" name="advMode" value="quality"> Quality (sharper)</label>
      </div>
      <div>
        <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="advExtreme" title="May be slow or unstable at very deep zoom."> Unlock extreme zoom (may be slow)</label>
        <div style="font:12px system-ui; opacity:.72; margin-top:4px">Reset View still returns to your starting view.</div>
      </div>
    </div>
  `;
  overlay.appendChild(pane);
  document.body.appendChild(overlay);

  const sync = () => {
    const p = state._perf || {};
    const mode = p.mode || 'balanced';
    const radios = pane.querySelectorAll('input[name="advMode"]');
    radios.forEach(r => { r.checked = (r.value === mode); });
    const chk = pane.querySelector('#advExtreme');
    chk.checked = !!p.unlockExtreme;
  };
  sync();

  pane.querySelector('#advClose')?.addEventListener('click', () => { overlay.style.display = 'none'; });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.style.display = 'none'; });
  pane.querySelectorAll('input[name="advMode"]').forEach(el => {
    el.addEventListener('change', () => { applyPerfMode(el.value); });
  });
  pane.querySelector('#advExtreme')?.addEventListener('change', (e) => {
    state._perf = state._perf || {};
    state._perf.unlockExtreme = !!e.target.checked;
    persistPerfProfile();
  });

  window._openAdvanced = () => { sync(); overlay.style.display = 'block'; };
}

function ensureAdvancedItem() {
  const menu = document.getElementById('ctxMenu');
  if (!menu) return;
  if (document.getElementById('ctxAdvanced')) return;
  try {
    const sep = document.createElement('div'); sep.className = 'sep';
    const item = document.createElement('div'); item.id = 'ctxAdvanced'; item.className = 'item'; item.setAttribute('role','menuitem');
    item.textContent = 'Advanced…';
    item.addEventListener('click', () => { hideCtxMenu(); window._openAdvanced?.(); });
    menu.appendChild(sep); menu.appendChild(item);
  } catch {}
}

// Manual calibration removed

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
  // Remember doc size for fit/zoom helpers
  try {
    const sz = doc.data?.size; if (sz && Number.isFinite(+sz.w) && Number.isFinite(+sz.h)) {
      state._docSize = { w: Math.max(1, +sz.w), h: Math.max(1, +sz.h) };
    } else { state._docSize = null; }
  } catch { state._docSize = null; }

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
    // Brush preset removed; always 'pen'
    // if (u.brush) state.brush = u.brush;
    if (u.tool) setTool(u.tool);
  }

  rebuildIndex(grid, state.strokes);

  if (doc.camera) {
    camera.scale = Number.isFinite(doc.camera.s) ? doc.camera.s : 1.25;
    camera.tx    = Number.isFinite(doc.camera.tx) ? doc.camera.tx : 0;
    camera.ty    = Number.isFinite(doc.camera.ty) ? doc.camera.ty : 0;
  } else {
    camera.scale = 1.25; camera.tx = 0; camera.ty = 0;
  }
  camera.setHome(camera.scale, camera.tx, camera.ty);
  try {
    const home = doc.createdCamera || { s: camera.scale, tx: camera.tx, ty: camera.ty };
    camera.setDocHome(Number.isFinite(home.s)?home.s:camera.scale, Number.isFinite(home.tx)?home.tx:camera.tx, Number.isFinite(home.ty)?home.ty:camera.ty);
  } catch {}

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
  tick._last = tick._last || performance.now();
  const now = performance.now();
  const dtSec = Math.max(0, Math.min(1/15, (now - tick._last) / 1000)); // clamp dt to avoid big jumps
  tick._last = now;
  if (state._anim?.playing) {
    state._anim.t = (state._anim.t || 0) + dtSec;
  }
  if (needsAnimFrame(state) || state._anim?.playing) scheduleRender();
  requestAnimationFrame(tick);
})();
// Load saved performance profile (if any)
function loadPerfProfile(){
  try{
    const raw = localStorage.getItem('dc_perf_profile');
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (p && typeof p === 'object') { state._perf = p; return p; }
  } catch {}
  return null;
}

// Device calibration: measure render time across zoom levels and store thresholds
let _calibrating = false;
async function calibrateDevicePerformance(){
  if (_calibrating) return;
  _calibrating = true;
  let off = null, octx = null;
  try {
    off = new OffscreenCanvas(canvas.width, canvas.height);
    octx = off.getContext('2d', { alpha: false });
  } catch {
    const c = document.createElement('canvas'); c.width = canvas.width; c.height = canvas.height; off = c;
    octx = c.getContext('2d');
  }
  const offLike = { clientWidth: canvas.clientWidth, clientHeight: canvas.clientHeight };
  const testCam = makeCamera(1, 0, 0);
  const prevExact = state._renderExact;
  const testDpr = Math.max(1, window.devicePixelRatio || 1);

  function measure(scale, exact){
    return new Promise(res => {
      testCam.scale = scale; testCam.tx = 0; testCam.ty = 0;
      const oldExact = state._renderExact;
      state._renderExact = !!exact;
      // warm
      render(state, testCam, octx, offLike, { dpr: testDpr, skipSnapshotPath: true, forceTrueComposite: true });
      const t0 = performance.now();
      render(state, testCam, octx, offLike, { dpr: testDpr, skipSnapshotPath: true, forceTrueComposite: true });
      const t1 = performance.now();
      state._renderExact = oldExact;
      res(t1 - t0);
    });
  }

  // Zoom-in calibration: find largest scale where exact rendering stays <= 16.7ms
  const zIn = [1,2,4,8,16,32,64,128,256];
  let simplifyDisableAtScale = 1.25;
  for (const s of zIn){
    const dt = await measure(s, /*exact*/true);
    if (dt <= 16.7) simplifyDisableAtScale = s; else break;
  }

  // Zoom-out calibration: choose smallest px tolerance that stays <=16.7ms over set scales
  const zOut = [0.5, 0.25, 0.125, 0.0625, 0.03125];
  const pxOpts = [0.2, 0.3, 0.4, 0.5, 0.6];
  let bestPxTol = 0.3;
  for (const px of pxOpts){
    const prev = state._perf || {};
    state._perf = { ...prev, lodPxTol: px, simplifyDisableAtScale };
    let ok = true;
    for (const s of zOut){
      const dt = await measure(s, /*exact*/false);
      if (dt > 16.7) { ok = false; break; }
    }
    if (ok) { bestPxTol = px; break; }
  }

  const perf = { simplifyDisableAtScale, lodPxTol: bestPxTol, ts: Date.now(), dpr: testDpr, w: canvas.width, h: canvas.height };
  state._perf = perf;
  // Preserve baseline for Advanced modes
  state._perfBase = { simplifyDisableAtScale, lodPxTol: bestPxTol };
  try { localStorage.setItem('dc_perf_profile', JSON.stringify(perf)); } catch {}
  state._renderExact = prevExact;
  scheduleRender();
  _calibrating = false;
}

// Debounced auto-calibration scheduler
let _calibTimer = 0;
function scheduleAutoCalibration(reason = ''){
  try { telemetry.record('calib.schedule', { reason }); } catch {}
  clearTimeout(_calibTimer);
  _calibTimer = setTimeout(() => { calibrateDevicePerformance(); }, 1200);
}
