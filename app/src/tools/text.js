// src/tools/text.js
import {
  addShape, removeStroke, updateShapeEnd, snapshotGeometry,
} from '../strokes.js';
import { scheduleRender, markDirty, setDeferIndex } from '../state.js';
import { update as updateIndex, grid } from '../spatial_index.js';
import { handleWorldRadius } from '../utils/pick.js';

// ------------------------- constants -----------------------------------------
const MIN_DRAG_PX        = 3;
const DEFAULT_BOX_W_SCR  = 280;
const DEFAULT_FS_SCR     = 24;
const BOX_MIN_W_SCR      = 60;
const BOX_MIN_H_SCR      = 36;
const ROT_OFFSET_PX      = 28;



function scrPxToWorld(px, camera){ return px / Math.max(1e-8, camera.scale); }

// rotate a point p around c by -theta (to bring world â†’ local box space)
function invRotateAround(p, c, theta){
  if (!theta) return { x: p.x, y: p.y };
  const s = Math.sin(-theta), co = Math.cos(-theta);
  const dx = p.x - c.x, dy = p.y - c.y;
  return { x: c.x + dx*co - dy*s, y: c.y + dx*s + dy*co };
}

function pointInRect(p, r){
  return p.x >= r.minx && p.x <= r.maxx && p.y >= r.miny && p.y <= r.maxy;
}

// top-most text whose (rotated) rect contains the point
function topTextAt(state, worldPt){
  const arr = state.strokes || state.shapes || [];
  for (let i = arr.length - 1; i >= 0; i--){
    const s = arr[i];
    if (!s || s.shape !== 'text') continue;
    const bb = bboxOf(s);
    const c  = { x:(bb.minx+bb.maxx)/2, y:(bb.miny+bb.maxy)/2 };
    const lp = invRotateAround(worldPt, c, s.rotation||0); // local, unrotated
    if (pointInRect(lp, bb)) return s;
  }
  return null;
}

function bboxOf(s){
  return {
    minx: Math.min(s.start.x, s.end.x),
    miny: Math.min(s.start.y, s.end.y),
    maxx: Math.max(s.start.x, s.end.x),
    maxy: Math.max(s.start.y, s.end.y),
  };
}

// keep this only in text.js
function hitHandleRotAware(worldPt, s, camera){
  const bb = bboxOf(s);
  const c  = { x:(bb.minx+bb.maxx)/2, y:(bb.miny+bb.maxy)/2 };
  const p  = invRotateAround(worldPt, c, s.rotation||0);
  const r  = handleWorldRadius(camera, 14); // slightly larger for easier grabbing

  const corners = {
    nw: { x:bb.minx, y:bb.miny },
    ne: { x:bb.maxx, y:bb.miny },
    se: { x:bb.maxx, y:bb.maxy },
    sw: { x:bb.minx, y:bb.maxy },
  };
  const mids = {
    n: { x:c.x,      y:bb.miny },
    e: { x:bb.maxx,  y:c.y     },
    s: { x:c.x,      y:bb.maxy },
    w: { x:bb.minx,  y:c.y     },
  };

  const rotWorld = { x: c.x, y: bb.miny - ROT_OFFSET_PX / Math.max(1e-8, camera.scale) };
  const rot = invRotateAround(rotWorld, c, s.rotation||0);
  const drx = p.x - rot.x, dry = p.y - rot.y;
  if ((drx*drx + dry*dry) <= (r*r)) return 'rot';

  // Optional move handle at 45deg from top-right corner (axis-aligned)
  const moveOffset = (ROT_OFFSET_PX / Math.max(1e-8, camera.scale)) / Math.SQRT2;
  const moveWorld = { x: bb.maxx + moveOffset, y: bb.miny - moveOffset };
  const mv = invRotateAround(moveWorld, c, s.rotation||0);
  const dmx = p.x - mv.x, dmy = p.y - mv.y;
  if ((dmx*dmx + dmy*dmy) <= (r*r)) return 'move';

  const all = { ...corners, ...mids };
  for (const [k, q] of Object.entries(all)) {
    const aabb = { minx:q.x-r, miny:q.y-r, maxx:q.x+r, maxy:q.y+r };
    if (pointInRect(p, aabb)) return k;
  }
  return null;
}

function scaleBBoxFromHandle(handle, bb, cursor, shiftUniform, altCenter){
  const cx = (bb.minx + bb.maxx) / 2, cy = (bb.miny + bb.maxy) / 2;
  let ox = altCenter ? cx : (
    handle === 'nw' ? bb.maxx :
    handle === 'ne' ? bb.minx :
    handle === 'se' ? bb.minx :
    handle === 'sw' ? bb.maxx :
    handle === 'e'  ? bb.minx :
    handle === 'w'  ? bb.maxx :
    handle === 'n'  ? cx     :
    handle === 's'  ? cx     : cx
  );
  let oy = altCenter ? cy : (
    handle === 'nw' ? bb.maxy :
    handle === 'ne' ? bb.maxy :
    handle === 'se' ? bb.miny :
    handle === 'sw' ? bb.miny :
    handle === 'e'  ? cy      :
    handle === 'w'  ? cy      :
    handle === 'n'  ? bb.maxy :
    handle === 's'  ? bb.miny : cy
  );

  const hot = {
    x: handle === 'nw' ? bb.minx :
       handle === 'ne' ? bb.maxx :
       handle === 'se' ? bb.maxx :
       handle === 'sw' ? bb.minx :
       handle === 'e'  ? bb.maxx :
       handle === 'w'  ? bb.minx :
       handle === 'n'  ? cx      :
       handle === 's'  ? cx      : cx,
    y: handle === 'nw' ? bb.miny :
       handle === 'ne' ? bb.miny :
       handle === 'se' ? bb.maxy :
       handle === 'sw' ? bb.maxy :
       handle === 'e'  ? cy      :
       handle === 'w'  ? cy      :
       handle === 'n'  ? bb.miny :
       handle === 's'  ? bb.maxy : cy,
  };

  const denomX = (hot.x - ox) || 1e-9;
  const denomY = (hot.y - oy) || 1e-9;
  let sx = (cursor.x - ox) / denomX;
  let sy = (cursor.y - oy) / denomY;

  if (handle === 'e' || handle === 'w'){ if (shiftUniform) sy = sx; else sy = 1; }
  else if (handle === 'n' || handle === 's'){ if (shiftUniform) sx = sy; else sx = 1; }
  else if (shiftUniform){ const u = Math.abs(Math.abs(sx) > Math.abs(sy) ? sx : sy); sx = Math.sign(sx)*u; sy = Math.sign(sy)*u; }

  const scalePt = (x,y)=>({ x: ox + (x-ox)*sx, y: oy + (y-oy)*sy });
  const p1 = scalePt(bb.minx, bb.miny);
  const p2 = scalePt(bb.maxx, bb.maxy);
  return { minx: Math.min(p1.x,p2.x), miny: Math.min(p1.y,p2.y), maxx: Math.max(p1.x,p2.x), maxy: Math.max(p1.y,p2.y) };
}

function ensureMinBox(s, camera){
  const minW = scrPxToWorld(BOX_MIN_W_SCR, camera);
  const minH = scrPxToWorld(BOX_MIN_H_SCR, camera);
  const x0 = Math.min(s.start.x, s.end.x);
  const y0 = Math.min(s.start.y, s.end.y);
  let w = Math.max(minW, Math.abs(s.end.x - s.start.x));
  let h = Math.max(minH, Math.abs(s.end.y - s.start.y));
  s.start.x = x0; s.start.y = y0;
  s.end.x   = x0 + w; s.end.y = y0 + h;
}

// ------------------- text measure + wrapping ---------------------------------
function setCtxFont(ctx, s, camera){
  const px = Math.max(1, Math.round((s.fontSize || scrPxToWorld(DEFAULT_FS_SCR, camera)) * camera.scale));
  const fam = s.fontFamily || 'system-ui,-apple-system,Segoe UI,Roboto,sans-serif';
  ctx.font = `${px}px ${fam}`;
}

function measure(ctx, text){ return ctx.measureText(text).width; }

function layoutTextAndGrow(s, camera, ctx, caretBlinkOn){
  const fs = s.fontSize || scrPxToWorld(DEFAULT_FS_SCR, camera);
  const lineH = (s.lineHeight || 1.25) * fs;
  const pad = 0.25 * fs;
  const wWorld = Math.max(1e-4, Math.abs(s.end.x - s.start.x));
  const maxWidthPx = Math.max(1, Math.floor(wWorld * camera.scale - 2 * pad * camera.scale));

  setCtxFont(ctx, s, camera);

  const raw = String(s.text || '').replace(/\r/g,'');
  const hardLines = raw.split('\n');

  const lines = [];
  const lineInfo = []; // { startIdx, endIdx } in raw string
  let globalIdx = 0;

  for (const hl of hardLines){
    if (hl.length === 0){
      lines.push('');
      lineInfo.push({ startIdx: globalIdx, endIdx: globalIdx });
      globalIdx += 1; // for '\n' division
      continue;
    }
    let i = 0;
    while (i < hl.length){
      let lo = 1, hi = hl.length - i, best = 1;
      // Greedy: expand until width > max, then back off to last break
      while (lo <= hi){
        const mid = ((lo + hi) >> 1);
        const slice = hl.slice(i, i + mid);
        const w = measure(ctx, slice);
        if (w <= maxWidthPx){ best = mid; lo = mid + 1; } else { hi = mid - 1; }
      }
      // try word boundary inside best
      let end = i + best;
      if (end < hl.length){
        const slice = hl.slice(i, end);
        const lastSpace = Math.max(slice.lastIndexOf(' '), slice.lastIndexOf('\t'));
        if (lastSpace > 0){ end = i + lastSpace + 1; }
      }
      const out = hl.slice(i, end);
      lines.push(out);
      lineInfo.push({ startIdx: globalIdx + i, endIdx: globalIdx + end });
      i = end;
    }
    globalIdx += hl.length + 1; // include implicit '\n' split
  }
  // fit height to content (no autosize font)
  const needed   = Math.max(scrPxToWorld(BOX_MIN_H_SCR, camera), pad + lines.length * lineH + pad);
  const x0       = Math.min(s.start.x, s.end.x);
  const y0       = Math.min(s.start.y, s.end.y);
  const w        = Math.abs(s.end.x - s.start.x);
  const currH    = Math.abs(s.end.y - s.start.y);
  const finalH   = Math.max(needed, currH);  // grow-only
  s.start.x = x0; s.start.y = y0;
  s.end.x   = x0 + w; s.end.y = y0 + finalH;

  s.lines = lines;
  s._lineInfo = lineInfo;

  s.bbox = {
    minx: Math.min(s.start.x, s.end.x),
    miny: Math.min(s.start.y, s.end.y),
    maxx: Math.max(s.start.x, s.end.x),
    maxy: Math.max(s.start.y, s.end.y),
  };

  // caret metrics (no string mutation): compute world-space caret x/y/height
  s._showCaret = !!(s.editing && caretBlinkOn);
  s._caret = null;
  s._lineWidths = lines.map(t => measure(ctx, t));
  if (s.editing && typeof s.caret === 'number' && s.lines && s.lines.length) {
    const { line, col } = caretLineColFromIndex(s, s.caret);
    setCtxFont(ctx, s, camera);
    const leftText = (s.lines[line] || '').slice(0, col);
    const leftPx = measure(ctx, leftText);          // px
    const x0 = Math.min(s.start.x, s.end.x);
    const y0 = Math.min(s.start.y, s.end.y);
    const w  = Math.abs(s.end.x - s.start.x);
    const lineWidthPx = s._lineWidths?.[line] || 0;
    const scale = Math.max(1e-8, camera.scale);
    const align = s.align || 'center';
    let leftEdgeWorld;
    if (align === 'left') {
      leftEdgeWorld = x0 + pad;
    } else if (align === 'right') {
      leftEdgeWorld = (x0 + w) - pad - (lineWidthPx / scale);
    } else {
      const centerWorld = x0 + w/2;
      leftEdgeWorld = centerWorld - (lineWidthPx / scale) * 0.5;
    }
    const xWorld = leftEdgeWorld + (leftPx / scale);
    const yWorld = y0 + pad + line * lineH;
  s._caret = { x: xWorld, y: yWorld, h: lineH };
  }
}

const __fsMeasureCanvas = (() => {
  try { return document.createElement('canvas'); } catch { return null; }
})();
const __fsMeasureCtx = __fsMeasureCanvas ? __fsMeasureCanvas.getContext('2d') : null;

/** Programmatically reflow a text shape after changing fontSize/lineHeight/text. */
export function relayoutTextShape(s, camera){
  if (!__fsMeasureCtx || !s || s.shape !== 'text') return;
  // false => caretBlinkOff; we only need geometry/lines here
  layoutTextAndGrow(s, camera, __fsMeasureCtx, false);
}

// map a global string index into (line, column) using _lineInfo
function caretLineColFromIndex(s, caretIdx){
  const info = s._lineInfo || [];
  for (let i = 0; i < info.length; i++){
    const { startIdx, endIdx } = info[i];
    if (caretIdx <= endIdx) {
      const col = Math.max(0, caretIdx - startIdx);
      return { line: i, col };
    }
  }
  // fallback: end of last line
  const L = (s.lines || []).length - 1;
  const col = (s.lines?.[L] || '').length;
  return { line: Math.max(0, L), col };
}

// convert (line,col) to global index
function lineColToIndex(s, line, col){
  const info = s._lineInfo || [];
  if (line <= 0) return Math.max(0, Math.min(col, (s.lines?.[0]||'').length));
  let idx = 0;
  for (let i=0;i<line;i++){
    idx = info[i]?.endIdx ?? idx;
  }
  return Math.max(0, idx + Math.min(col, (s.lines?.[line]||'').length));
}
// --------------------------- tool --------------------------------------------
export class TextTool {
  constructor({ canvas, camera, state }) {
    this.canvas = canvas;
    this.camera = camera;
    this.state  = state;
    this._hoverHandle = null;

    this._active = null;

    // drafting a new box
    this._drafting = false;
    this._downWorld = null;
    this._downScreen = null;

    // transform state
    this._mode = null;     // 'move' | 'scale' | 'rotate' | null
    this._handle = null;
    this._before = null;
    this._dragMove = null;
    this._rotPivot = null;
    this._rotAngle0 = 0;
    this._grabLocalFromCenter = null; // local grab vector (relative to center)
    this._half = null;                // half extents captured at pointer-down
    this._selecting = false;
    this._selAnchor = null;

    // caret blink
    this._blinkOn = true;
    this._blinkTimer = setInterval(() => {
      this._blinkOn = !this._blinkOn;
      if (this._active) { layoutTextAndGrow(this._active, this.camera, this._ctx, this._blinkOn); scheduleRender(); }
    }, 500);

    // accurate text measuring
    this._offscreen = document.createElement('canvas');
    this._ctx = this._offscreen.getContext('2d');

    // clicking outside the canvas ends edit; clicking empty canvas (left-click) also ends edit
    this._onDocPointerDown = (e) => {
      // Only respond when Text tool is active
      if (this.state?.tool !== 'text') return;
      const withinCanvas = (e.target === this.canvas) || e.target.closest?.('canvas');
      const withinUi = e.target.closest?.('[data-dc-ui="true"]');
      // Click outside canvas/UI: end editing (confirm delete if empty)
      if (!withinCanvas && !withinUi && this._active) { this._finishEditing(true); return; }
      // Left-click on empty canvas (not UI, not on text/handles): end editing (but don't auto-delete)
      if (withinCanvas && !withinUi && e.button === 0 && this._active) {
        try {
          const r = this.canvas.getBoundingClientRect();
          const screen = { x: e.clientX - r.left, y: e.clientY - r.top };
          const world  = this.camera.screenToWorld(screen);
          const s = this._active;
          const h = hitHandleRotAware(world, s, this.camera);
          if (h) return; // let handle interactions proceed
          const bb = bboxOf(s);
          const c  = { x:(bb.minx+bb.maxx)/2, y:(bb.miny+bb.maxy)/2 };
          const lp = invRotateAround(world, c, s.rotation||0);
          if (pointInRect(lp, bb)) return; // inside text box: let caret/selection proceed
          // Empty canvas click: finish editing (non-destructive)
          this._finishEditing(false);
        } catch {}
      }
    };
    document.addEventListener('pointerdown', this._onDocPointerDown, { capture: true });

    // typing
    this._onKeyDown = (e) => this._handleKeyDown(e);
    this._onPaste   = (e) => this._handlePaste(e);
    // Robust clipboard support: handle native copy/cut events too
    this._onCopy    = (e) => this._handleCopyEvent(e);
    this._onCut     = (e) => this._handleCutEvent(e);
    window.addEventListener('keydown', this._onKeyDown, { capture: true });
    window.addEventListener('paste',   this._onPaste,   { capture: true });
    window.addEventListener('copy',    this._onCopy,    { capture: true });
    window.addEventListener('cut',     this._onCut,     { capture: true });

    // track original text for a single coalesced history entry
    this._sessionTextBefore = null;
    // in-session text edit undo/redo stacks
    this._editUndo = [];
    this._editRedo = [];

    // Create on double-click anywhere on the canvas when Text tool is active
    this._onCanvasDblClick = (e) => {
      if (this.state?.tool !== 'text') return;
      try { e.preventDefault(); } catch {}
      const r = this.canvas.getBoundingClientRect();
      const screen = { x: e.clientX - r.left, y: e.clientY - r.top };
      const world  = this.camera.screenToWorld(screen);
      try { this._finishEditing(true); } catch {}
      const s = this._newTextShapeAt(world);
      this._beginEditing(s);
      scheduleRender();
    };
  this.canvas.addEventListener('dblclick', this._onCanvasDblClick, { capture:false });
    // Document-level fallback handlers (bound so they can be added/removed)
    this._docSelectMove = (e) => this._docPointerMoveFallback(e);
    this._docSelectUp   = (e) => this._docPointerUpFallback(e);
  }

  _setCursor(c){ try{ this.canvas.style.cursor=c; }catch{} }
  _cursorForHandle(h){
    return h==='n'||h==='s' ? 'ns-resize' :
           h==='e'||h==='w' ? 'ew-resize' :
           h==='ne'||h==='sw'? 'nesw-resize' :
           h==='nw'||h==='se'? 'nwse-resize' :
           h==='move'        ? 'move' :
           h==='rot'          ? 'grab' :
           this._active ? 'text' : 'crosshair';
  }

  destroy(){
    document.removeEventListener('pointerdown', this._onDocPointerDown, { capture: true });
    window.removeEventListener('keydown', this._onKeyDown, { capture: true });
    window.removeEventListener('paste',   this._onPaste,   { capture: true });
    window.removeEventListener('copy',    this._onCopy,    { capture: true });
    window.removeEventListener('cut',     this._onCut,     { capture: true });
    // Ensure fallback listeners removed
    try { document.removeEventListener('pointermove', this._docSelectMove, { capture: true }); } catch {}
    try { document.removeEventListener('pointerup',   this._docSelectUp,   { capture: true }); } catch {}
    try { window.__dcHideTextSizeUI?.(); } catch {}
    try { this.canvas.removeEventListener('dblclick', this._onCanvasDblClick, { capture:false }); } catch {}
    clearInterval(this._blinkTimer);
  }

  // ---- lifecycle ----
  _beginEditing(shape){
    if (!shape) return;
    shape.editing = true;
    shape.caret = (typeof shape.caret === 'number') ? shape.caret : (shape.text||'').length;
    shape.selStart = shape.caret;
    shape.selEnd   = shape.caret;
    try { this.state.selection.clear(); this.state.selection.add(shape); } catch {}
    this._active = shape;
    // reset per-session undo/redo and seed initial snapshot
    this._editUndo = [{ text: String(shape.text||''), caret: shape.caret||0 }];
    this._editRedo = [];
    // snapshot original text for undo/redo
    this._sessionTextBefore = String(shape.text || '');
    layoutTextAndGrow(shape, this.camera, this._ctx, this._blinkOn);
    scheduleRender();
  }
  _finishEditing(confirm = true){
    const s = this._active; if (!s) return;
    if (confirm) {
      const txt = String(s.text || '').trim();
      if (!txt) { removeStroke(this.state, s); this._active = null; markDirty(); scheduleRender(); return; }
    }
    s.editing = false;
    s.pipeLines = null;
    window.__dcHideTextSizeUI?.();
    markDirty(); 
    scheduleRender();
    s.selStart = s.selEnd = s.caret ?? 0;
    try { this.state.selection.clear(); } catch {}
    // If content changed, push a single history mutation for the session
    try {
      const before = (this._sessionTextBefore != null) ? this._sessionTextBefore : String(s.text || '');
      const after  = String(s.text || '');
      if (before !== after) {
        this.state.history?.pushTextChange?.(s, before, after);
      }
    } catch {}
    // Update spatial index in case layout changed bbox during typing
    try { updateIndex(grid, s); } catch {}
    this._active = null;
    this._mode = null; this._handle = null;
    this._dragMove = null; this._before = null;
    this._sessionTextBefore = null;
    // clear per-session stacks
    this._editUndo = [];
    this._editRedo = [];
    scheduleRender();
  }

  // ---- create shape ----
  _newTextShapeAt(worldPt){
    const fsWorld = scrPxToWorld(DEFAULT_FS_SCR, this.camera);
    const wWorld  = scrPxToWorld(DEFAULT_BOX_W_SCR, this.camera);
    const lhMul   = 1.25;
    const hWorld  = Math.max(scrPxToWorld(BOX_MIN_H_SCR, this.camera), lhMul * fsWorld + scrPxToWorld(16, this.camera));

    const s = addShape(this.state, {
      shape: 'text',
      brush: 'pen',
      color: this.state?.settings?.color || '#e6eaf0',
      alpha: (typeof this.state?.settings?.opacity === 'number') ? this.state.settings.opacity : 1,
      w: 1,
      start: { x: worldPt.x, y: worldPt.y },
      end:   { x: worldPt.x + wWorld, y: worldPt.y + hWorld },
      fill: false
    });

    s.text        = '';
  // Prefer the per-document setting (state.settings.fontFamily) when creating a new text shape.
  s.fontFamily  = (this.state?.settings?.fontFamily) || s.fontFamily || 'system-ui,-apple-system,Segoe UI,Roboto,sans-serif';
    s.fontSize    = fsWorld;        // fixed size (no autosize)
    s.lineHeight  = lhMul;          // Ã— fontSize
    s.rotation    = s.rotation || 0;
    s.caret       = 0;

    ensureMinBox(s, this.camera);
    layoutTextAndGrow(s, this.camera, this._ctx, this._blinkOn);
    markDirty(); scheduleRender();
    return s;
  }

  // ---- text edit core ----
  _setCaretFromPoint(worldPt){
    const s = this._active; if (!s) return;
    const bb = bboxOf(s);
    const cx = (bb.minx+bb.maxx)/2, cy = (bb.miny+bb.maxy)/2;
    const lp = invRotateAround(worldPt, {x:cx,y:cy}, s.rotation||0);
    const pad = 0.25 * (s.fontSize || scrPxToWorld(DEFAULT_FS_SCR, this.camera));
    const lineH = (s.lineHeight || 1.25) * (s.fontSize || scrPxToWorld(DEFAULT_FS_SCR, this.camera));

    const wBox = bb.maxx - bb.minx;
    const scale = Math.max(1e-8, this.camera.scale);
    const yLocal = lp.y - bb.miny - pad;

    const line = Math.max(0, Math.min(s.lines.length-1, Math.floor(yLocal / lineH)));
    setCtxFont(this._ctx, s, this.camera);
    const text = s.lines[line] || '';
    const lineWidthPx = measure(this._ctx, text);
    const align = s.align || 'center';
    let leftEdgeWorld;
    if (align === 'left') {
      leftEdgeWorld = bb.minx + pad;
    } else if (align === 'right') {
      leftEdgeWorld = (bb.minx + wBox) - pad - (lineWidthPx / scale);
    } else {
      const centerWorld = bb.minx + wBox/2;
      leftEdgeWorld = centerWorld - (lineWidthPx / scale) * 0.5;
    }
    let xPx = (lp.x - leftEdgeWorld) * scale;
    // clamp to [0, lineWidthPx]
    if (!Number.isFinite(xPx)) xPx = 0;
    xPx = Math.max(0, Math.min(lineWidthPx, xPx));

    // Compare in *pixels* using midpoints between characters so clicks fall between letters
    let col = 0;
    if (text.length === 0) {
      col = 0;
    } else {
      const pos = new Array(text.length + 1);
        const pad = 0.25 * (s.fontSize || scrPxToWorld(DEFAULT_FS_SCR, this.camera));
        const lineH = (s.lineHeight || 1.25) * (s.fontSize || scrPxToWorld(DEFAULT_FS_SCR, this.camera));
      for (let i = 0; i < text.length; i++){
        const mid = (pos[i] + pos[i+1]) * 0.5;
        if (xPx <= mid) { col = i; break; }
        col = i+1;
      }
    }
    // clamp into valid range
    if (col < 0) col = 0;
    if (col > text.length) col = text.length;
    s.caret = lineColToIndex(s, line, col);
    layoutTextAndGrow(s, this.camera, this._ctx, this._blinkOn);
  }

  _caretIndexFromPoint(worldPt){
    const s = this._active; if (!s) return 0;
    const bb = bboxOf(s);
    const cx = (bb.minx+bb.maxx)/2, cy = (bb.miny+bb.maxy)/2;
    const lp = invRotateAround(worldPt, {x:cx,y:cy}, s.rotation||0);
    const fs = s.fontSize || scrPxToWorld(DEFAULT_FS_SCR, this.camera);
    const pad = 0.25 * fs;
    const lineH = (s.lineHeight || 1.25) * fs;
    const scale = Math.max(1e-8, this.camera.scale);
    const yLocal = lp.y - Math.min(s.start.y, s.end.y) - pad;
    const line = Math.max(0, Math.min((s.lines||[]).length-1, Math.floor(yLocal / lineH)));
    setCtxFont(this._ctx, s, this.camera);
    const text = (s.lines||[])[line] || '';
    const lineWidthPx = this._ctx.measureText(text).width;
    const wBox = Math.abs(s.end.x - s.start.x);
    const align = s.align || 'center';
    const xLeftWorld = Math.min(s.start.x, s.end.x);
    let leftEdgeWorld;
    if (align === 'left') {
      leftEdgeWorld = xLeftWorld + pad;
    } else if (align === 'right') {
      leftEdgeWorld = xLeftWorld + wBox - pad - (lineWidthPx / scale);
    } else {
      const centerWorld = xLeftWorld + wBox/2;
      leftEdgeWorld = centerWorld - (lineWidthPx / scale) * 0.5;
    }
    let xPx = (lp.x - leftEdgeWorld) * scale;
    if (!Number.isFinite(xPx)) xPx = 0;
    xPx = Math.max(0, Math.min(lineWidthPx, xPx));
    let col = 0;
    if (text.length === 0) {
      col = 0;
    } else {
      const pos = new Array(text.length + 1);
      for (let i = 0; i <= text.length; i++) pos[i] = this._ctx.measureText(text.slice(0, i)).width;
      for (let i = 0; i < text.length; i++){
        const mid = (pos[i] + pos[i+1]) * 0.5;
        if (xPx <= mid) { col = i; break; }
        col = i+1;
      }
    }
    return lineColToIndex(s, line, Math.max(0, Math.min(text.length, col)));
  }

  _insertAtCaret(txt){
    const s = this._active; if (!s) return;
    this._pushEditSnapshot();
    const t = String(s.text || '');
    // replace selection if present
    const sel = this._deleteSelectionIfAny();
    const i = (sel != null) ? sel : Math.max(0, Math.min(t.length, s.caret ?? t.length));
    const cur = String(s.text || '');
    s.text = cur.slice(0, i) + txt + cur.slice(i);
    s.caret = i + txt.length;
    s.selStart = s.selEnd = s.caret;
    this._blinkOn = true;
    layoutTextAndGrow(s, this.camera, this._ctx, this._blinkOn);
    markDirty(); scheduleRender();
  }
  _newline(){ this._insertAtCaret('\n'); }
  _backspace(){
    const s = this._active; if (!s) return;
    const t = String(s.text || ''); if (!t) return;
    this._pushEditSnapshot();
    if (this._deleteSelectionIfAny() != null) {
      // selection deleted; caret already set
    } else {
      const i = Math.max(0, Math.min(t.length, s.caret ?? t.length));
      if (i === 0) return;
      s.text = t.slice(0, i-1) + t.slice(i);
      s.caret = i-1;
      s.selStart = s.selEnd = s.caret;
    }
    layoutTextAndGrow(s, this.camera, this._ctx, this._blinkOn);
    markDirty(); scheduleRender();
  }
  _delForward(){
    const s = this._active; if (!s) return;
    const t = String(s.text || ''); if (!t) return;
    this._pushEditSnapshot();
    if (this._deleteSelectionIfAny() != null) {
      // selection deleted
    } else {
      const i = Math.max(0, Math.min(t.length, s.caret ?? t.length));
      if (i >= t.length) return;
      s.text = t.slice(0, i) + t.slice(i+1);
      s.selStart = s.selEnd = s.caret;
    }
    layoutTextAndGrow(s, this.camera, this._ctx, this._blinkOn);
    markDirty(); scheduleRender();
  }

  _deleteSelectionIfAny(){
    const s = this._active; if (!s) return null;
    let a = Number.isFinite(s.selStart) ? s.selStart : s.caret||0;
    let b = Number.isFinite(s.selEnd)   ? s.selEnd   : s.caret||0;
    if (a === b) return null;
    if (a > b) { const tmp = a; a = b; b = tmp; }
    const t = String(s.text || '');
    a = Math.max(0, Math.min(t.length, a));
    b = Math.max(0, Math.min(t.length, b));
    s.text = t.slice(0, a) + t.slice(b);
    s.caret = a;
    s.selStart = s.selEnd = s.caret;
    return a;
  }
  _pushEditSnapshot(){
    const s = this._active; if (!s) return;
    try {
      const last = this._editUndo[this._editUndo.length-1];
      const cur = { text: String(s.text||''), caret: s.caret||0 };
      if (!last || last.text !== cur.text || last.caret !== cur.caret) {
        this._editUndo.push(cur);
      }
      this._editRedo.length = 0; // clear redo on new edit
    } catch {}
  }
  _undoEdit(){
    const s = this._active; if (!s) return;
    if (!this._editUndo || this._editUndo.length <= 1) return; // keep initial
    const cur = { text: String(s.text||''), caret: s.caret||0 };
    const prev = this._editUndo[this._editUndo.length - 2];
    this._editRedo.push(cur);
    this._editUndo.pop();
    s.text = prev.text; s.caret = prev.caret;
    layoutTextAndGrow(s, this.camera, this._ctx, this._blinkOn);
    markDirty(); scheduleRender();
  }
  _redoEdit(){
    const s = this._active; if (!s) return;
    const nxt = this._editRedo && this._editRedo.pop();
    if (!nxt) return;
    // push current into undo
    this._editUndo.push({ text: String(s.text||''), caret: s.caret||0 });
    s.text = nxt.text; s.caret = nxt.caret;
    layoutTextAndGrow(s, this.camera, this._ctx, this._blinkOn);
    markDirty(); scheduleRender();
  }
  async _copyEdit(){
    const s = this._active; if (!s) return;
    let text = String(s.text || '');
    try {
      let a = Number.isFinite(s.selStart) ? s.selStart : s.caret||0;
      let b = Number.isFinite(s.selEnd)   ? s.selEnd   : s.caret||0;
      if (a !== b) { if (a>b) { const t=a;a=b;b=t; } text = text.slice(a, b); }
    } catch {}
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text; ta.style.position='fixed'; ta.style.left='-9999px';
        document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); } catch {}
        document.body.removeChild(ta);
      }
    } catch {}
  }

  _activeAndNotInUi(target){
    if (this.state?.tool !== 'text') return null;
    if (!this._active) return null;
    const tgt = target;
    const ae  = document.activeElement;
    const inUi =
      tgt?.closest?.('[data-dc-ui="true"]') ||
      ae?.closest?.('[data-dc-ui="true"]') ||
      (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable)) ||
      (ae  && (ae.tagName  === 'INPUT' || ae.tagName  === 'TEXTAREA' || ae.isContentEditable));
    if (inUi) return null;
    return this._active;
  }

  // Document-level fallback to update selection if pointer capture isn't available
  _docPointerMoveFallback(e){
    try {
      if (!this._selecting || !this._active) return;
      const r = this.canvas.getBoundingClientRect();
      const screen = { x: e.clientX - r.left, y: e.clientY - r.top };
      const world  = this.camera.screenToWorld(screen);
      const idx = this._caretIndexFromPoint(world);
      const s = this._active;
      s.caret = idx;
      const anchor = Number.isFinite(this._selAnchor) ? this._selAnchor : (s.selStart ?? idx);
      s.selStart = Math.min(anchor, idx); s.selEnd = Math.max(anchor, idx);
      layoutTextAndGrow(s, this.camera, this._ctx, this._blinkOn);
      markDirty(); scheduleRender();
    } catch (err) { /* ignore fallback errors */ }
  }

  _docPointerUpFallback(e){
    try {
        if (this._selecting) {
          this._selecting = false; this._selAnchor = null;
        }
      try { document.removeEventListener('pointermove', this._docSelectMove, { capture: true }); } catch {}
      try { document.removeEventListener('pointerup',   this._docSelectUp,   { capture: true }); } catch {}
      try { this.canvas.releasePointerCapture?.(e.pointerId); } catch {}
      layoutTextAndGrow(this._active, this.camera, this._ctx, this._blinkOn); scheduleRender();
      } catch (err) { /* ignore fallback errors */ }
  }

  _selectedText(){
    const s = this._active; if (!s) return '';
    let text = String(s.text || '');
    try {
      let a = Number.isFinite(s.selStart) ? s.selStart : s.caret||0;
      let b = Number.isFinite(s.selEnd)   ? s.selEnd   : s.caret||0;
      if (a !== b) { if (a>b) { const t=a;a=b;b=t; } text = text.slice(a, b); }
    } catch {}
    return text;
  }

  _handleCopyEvent(e){
    const s = this._activeAndNotInUi(e.target); if (!s) return;
    try {
      const text = this._selectedText();
      if (e && e.clipboardData && typeof e.clipboardData.setData === 'function'){
        e.clipboardData.setData('text/plain', text);
        e.preventDefault();
        return;
      }
    } catch {}
    // Fallback to existing async clipboard path
    try { this._copyEdit(); } catch {}
  }

  _handleCutEvent(e){
    const s = this._activeAndNotInUi(e.target); if (!s) return;
    try {
      const text = this._selectedText();
      if (e && e.clipboardData && typeof e.clipboardData.setData === 'function'){
        e.clipboardData.setData('text/plain', text);
        e.preventDefault();
        // After placing on clipboard, remove selection
        this._pushEditSnapshot();
        this._deleteSelectionIfAny() ?? (s.text = '');
        layoutTextAndGrow(s, this.camera, this._ctx, this._blinkOn);
        markDirty(); scheduleRender();
        return;
      }
    } catch {}
    // Fallback when clipboardData isn't available
    (async () => {
      try { await this._copyEdit(); } catch {}
      try {
        this._pushEditSnapshot();
        this._deleteSelectionIfAny() ?? (s.text = '');
        layoutTextAndGrow(s, this.camera, this._ctx, this._blinkOn);
        markDirty(); scheduleRender();
      } catch {}
    })();
  }

  // ---- keyboard ----
  async _handleKeyDown(e){
    // Only respond when Text tool is active
    if (this.state?.tool !== 'text') return;
    const tgt = e.target;
    const ae  = document.activeElement;
    const inUi =
      tgt?.closest?.('[data-dc-ui="true"]') ||
      ae?.closest?.('[data-dc-ui="true"]') ||
      (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable)) ||
      (ae  && (ae.tagName  === 'INPUT' || ae.tagName  === 'TEXTAREA' || ae.isContentEditable));
    if (inUi) return;

    // Allow global shortcuts except edit-critical keys below
    if (e.key === 'Delete'){
      if (this._active){
        e.preventDefault();
        const s = this._active;
        removeStroke(this.state, s);
        this._active = null;
        try { window.__dcHideTextSizeUI?.(); } catch {}
        markDirty(); scheduleRender();
      }
      return;
    }

    if (!this._active) return;

    if (e.metaKey || e.ctrlKey){
      const k = (e.key || '').toLowerCase();
      if (k === 'a'){ e.preventDefault(); const s=this._active; const L=(s.text||'').length; s.selStart=0; s.selEnd=L; s.caret=L; layoutTextAndGrow(s,this.camera,this._ctx,this._blinkOn); scheduleRender(); return; }
      if (k === 'c'){
        e.preventDefault(); try { await this._copyEdit(); } catch {}
        return;
      }
      if (k === 'x'){
        e.preventDefault(); try { await this._copyEdit(); } catch {}
        try { this._pushEditSnapshot(); this._deleteSelectionIfAny() ?? (this._active.text = ''); layoutTextAndGrow(this._active,this.camera,this._ctx,this._blinkOn); markDirty(); scheduleRender(); } catch {}
        return;
      }
      if (k === 'v'){
        e.preventDefault();
        try {
          let raw = '';
          try { raw = (e.clipboardData || window.clipboardData)?.getData?.('text') || ''; } catch {}
          if (!raw && navigator?.clipboard?.readText) raw = await navigator.clipboard.readText();
          if (raw) { const MAX = 10000; const txt = String(raw).replace(/\r/g,'').slice(0, MAX); this._insertAtCaret(txt); }
        } catch {}
        return;
      }
      if (k === 'z'){ e.preventDefault(); e.stopPropagation(); if (e.shiftKey) this._redoEdit(); else this._undoEdit(); return; }
      if (k === 'y'){ e.preventDefault(); e.stopPropagation(); this._redoEdit(); return; }
      return;
    }

    // navigation
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight'){
      e.preventDefault();
      const s = this._active; const len = (s.text||'').length; const cur = s.caret||0;
      const next = (e.key==='ArrowLeft') ? Math.max(0, cur-1) : Math.min(len, cur+1);
      if (e.shiftKey){
        const anchor = (s.selStart!==s.selEnd) ? ( (s.selStart===cur) ? s.selEnd : s.selStart ) : cur;
        s.caret = next; s.selStart = Math.min(anchor, next); s.selEnd = Math.max(anchor, next);
      } else {
        s.caret = next; s.selStart = s.selEnd = s.caret;
      }
      layoutTextAndGrow(s, this.camera, this._ctx, this._blinkOn); scheduleRender(); return;
    }
    if (e.key === 'ArrowUp'){
      e.preventDefault();
      const s = this._active; const pos = caretLineColFromIndex(s, s.caret||0);
      const up = Math.max(0, pos.line-1); s.caret = lineColToIndex(s, up, pos.col);
      layoutTextAndGrow(s, this.camera, this._ctx, this._blinkOn); scheduleRender(); return;
    }
    if (e.key === 'ArrowDown'){
      e.preventDefault();
      const s = this._active; const pos = caretLineColFromIndex(s, s.caret||0);
      const dn = Math.min((s.lines||[]).length-1, pos.line+1); s.caret = lineColToIndex(s, dn, pos.col);
      layoutTextAndGrow(s, this.camera, this._ctx, this._blinkOn); scheduleRender(); return;
    }
    if (e.key === 'Home' || e.key === 'End'){
      e.preventDefault(); const s=this._active; const pos=caretLineColFromIndex(s,s.caret||0);
      const homeIdx = lineColToIndex(s,pos.line,0);
      const endIdx  = lineColToIndex(s,pos.line,(s.lines?.[pos.line]||'').length);
      const dest = (e.key==='Home') ? homeIdx : endIdx;
      if (e.shiftKey){
        const anchor = (s.selStart!==s.selEnd) ? ( (s.selStart===s.caret) ? s.selEnd : s.selStart ) : s.caret;
        s.caret = dest; s.selStart = Math.min(anchor, dest); s.selEnd = Math.max(anchor, dest);
      } else { s.caret = dest; s.selStart = s.selEnd = s.caret; }
      layoutTextAndGrow(s,this.camera,this._ctx,this._blinkOn); scheduleRender(); return;
    }

    if (e.key === 'Enter')     { e.preventDefault(); this._newline(); return; }
    if (e.key === 'Backspace') { e.preventDefault(); this._backspace(); return; }
    if (e.key === 'Escape')    { e.preventDefault(); this._finishEditing(true); return; }
    if (e.key === 'Tab')       { e.preventDefault(); this._insertAtCaret('  '); return; }
    if (e.key === 'Delete')    { e.preventDefault(); this._delForward(); return; } // (not reached due to early return)

    if (e.key && e.key.length === 1) { e.preventDefault(); this._insertAtCaret(e.key); }
  }
  _handlePaste(e){
    // Only respond when Text tool is active
    if (this.state?.tool !== 'text') return;
    if (!this._active) return;
    // Don't paste into the text shape if the UI owns focus
    const tgt = e.target;
    const ae  = document.activeElement;
    if (tgt?.closest?.('[data-dc-ui="true"]') || ae?.closest?.('[data-dc-ui="true"]')) return;
    try{
      let raw = '';
      try { raw = (e.clipboardData || window.clipboardData)?.getData?.('text') || ''; } catch {}
      if (raw && typeof raw === 'string'){
        e.preventDefault();
        const MAX = 10000;
        const txt = String(raw).replace(/\r/g,'').slice(0, MAX);
        this._insertAtCaret(txt);
        return;
      }
      // Fallback to async clipboard API if event data not provided
      if (navigator?.clipboard?.readText) {
        (async () => {
          try {
            const v = await navigator.clipboard.readText();
            if (v && this._active) {
              const MAX = 10000;
              const txt = String(v).replace(/\r/g,'').slice(0, MAX);
              this._insertAtCaret(txt);
              scheduleRender();
            }
          } catch {}
        })();
      }
    } catch {}
  }

  // ---- pointer ----
  onPointerDown(e){
    if (e.button !== 0) return;
    const r = this.canvas.getBoundingClientRect();
    const screen = { x: e.clientX - r.left, y: e.clientY - r.top };
    const world  = this.camera.screenToWorld(screen);

    if (!this._drafting && !this._before){
      const s = this._active || topTextAt(this.state, world);
      let h = null;
      if (s) h = hitHandleRotAware(world, s, this.camera);
      this._hoverHandle = h;
      this._setCursor(this._cursorForHandle(h));
    }

    // --- If a text is already active, keep your existing flow ---
    if (this._active){
      const s = this._active;
      const h = hitHandleRotAware(world, s, this.camera);
  // active text hit check
      if (h === 'rot'){
        this._mode = 'rotate';
        this._handle = 'rot';
        const bb = bboxOf(s);
        this._rotPivot = { x:(bb.minx+bb.maxx)/2, y:(bb.miny+bb.maxy)/2 };
        const a0p = Math.atan2(world.y - this._rotPivot.y, world.x - this._rotPivot.x);
        this._rotAngle0 = a0p;
        this._before = snapshotGeometry(s);
        try { this.canvas.setPointerCapture(e.pointerId); } catch {}
        this._setCursor('grabbing');
        return;
      } else if (h === 'move'){
        // Move via dedicated move-handle
        this._mode = 'move';
        this._handle = 'move';
        const bb = bboxOf(s);
        const c  = { x:(bb.minx+bb.maxx)/2, y:(bb.miny+bb.maxy)/2 };
        const lp = invRotateAround(world, c, s.rotation||0);
        this._before = snapshotGeometry(s);
        this._half = { x:(bb.maxx-bb.minx)/2, y:(bb.maxy-bb.miny)/2 };
        this._grabLocalFromCenter = { x: lp.x - c.x, y: lp.y - c.y };
        try { this.canvas.setPointerCapture(e.pointerId); } catch {}
        this._setCursor('move');
        return;
      } else if (h){
        this._mode = 'scale';
        this._handle = h;
        this._before = snapshotGeometry(s);
        try { this.canvas.setPointerCapture(e.pointerId); } catch {}
        return;
      } else {
        // inside? set caret or start move depending on hit (rot-aware)
        const bb = bboxOf(s);
        const c  = { x:(bb.minx+bb.maxx)/2, y:(bb.miny+bb.maxy)/2 };
  const lp = invRotateAround(world, c, s.rotation||0);
  const isInside = pointInRect(lp, bb);
  if (isInside){
          // Always start caret/selection when clicking inside the text box.
          const idx = this._caretIndexFromPoint(world);
          s.caret = idx;
          if (e.shiftKey){
            const anchor = Number.isFinite(s.selStart) && Number.isFinite(s.selEnd) && s.selStart !== s.selEnd
              ? (s.selStart === s.caret ? s.selEnd : s.selStart)
              : (s.selStart ?? idx);
            s.selStart = Math.min(anchor, idx); s.selEnd = Math.max(anchor, idx);
          } else { s.selStart = s.selEnd = idx; }
          this._selecting = true; this._selAnchor = s.selStart;
          try { this.canvas.setPointerCapture(e.pointerId); } catch {}
          layoutTextAndGrow(s, this.camera, this._ctx, this._blinkOn); scheduleRender();
          return;
        }
        // clicked elsewhere: try hitting any text handles before finishing
        {
          const arr = this.state.strokes || this.state.shapes || [];
          for (let i = arr.length - 1; i >= 0; i--){
            const t = arr[i];
            if (!t || t.shape !== 'text') continue;
            const hh = hitHandleRotAware(world, t, this.camera);
            if (!hh) continue;
            this._beginEditing(t);
            if (hh === 'rot'){
              this._mode = 'rotate';
              this._handle = 'rot';
              const bbx = bboxOf(t);
              this._rotPivot = { x:(bbx.minx+bbx.maxx)/2, y:(bbx.miny+bbx.maxy)/2 };
              this._rotAngle0 = Math.atan2(world.y - this._rotPivot.y, world.x - this._rotPivot.x);
              this._before = snapshotGeometry(t);
              try { this.canvas.setPointerCapture(e.pointerId); } catch {}
              return;
            } else if (hh === 'move'){
              this._mode = 'move';
              this._handle = 'move';
              const bbx = bboxOf(t);
              const c   = { x:(bbx.minx+bbx.maxx)/2, y:(bbx.miny+bbx.maxy)/2 };
              const lp  = invRotateAround(world, c, t.rotation||0);
              this._before = snapshotGeometry(t);
              this._half = { x:(bbx.maxx-bbx.minx)/2, y:(bbx.maxy-bbx.miny)/2 };
              this._grabLocalFromCenter = { x: lp.x - c.x, y: lp.y - c.y };
              try { this.canvas.setPointerCapture(e.pointerId); } catch {}
              this._setCursor('move');
              return;
            } else {
              this._mode = 'scale';
              this._handle = hh;
              this._before = snapshotGeometry(t);
              try { this.canvas.setPointerCapture(e.pointerId); } catch {}
              return;
            }
          }
        }
        // nothing else hit → just end editing without deleting empty text
        this._finishEditing(false);
      }
    }

    // --- Not active yet: first try inside-rect hit ---
  const hitText = topTextAt(this.state, world);
    if (hitText){
      this._beginEditing(hitText);

      // Try handles immediately on the same click
  const h = hitHandleRotAware(world, hitText, this.camera);
  // hitText handle check
      if (h === 'rot'){
        this._mode = 'rotate';
        this._handle = 'rot';
        const bb = bboxOf(hitText);
        this._rotPivot = { x:(bb.minx+bb.maxx)/2, y:(bb.miny+bb.maxy)/2 };
        this._rotAngle0 = Math.atan2(world.y - this._rotPivot.y, world.x - this._rotPivot.x);
        this._before = snapshotGeometry(hitText);
        try { this.canvas.setPointerCapture(e.pointerId); } catch {}
        return;
      } else if (h === 'move'){
        this._mode = 'move';
        this._handle = 'move';
        const bb = bboxOf(hitText);
        const c  = { x:(bb.minx+bb.maxx)/2, y:(bb.miny+bb.maxy)/2 };
        const lp = invRotateAround(world, c, hitText.rotation||0);
        this._before = snapshotGeometry(hitText);
        this._half = { x:(bb.maxx-bb.minx)/2, y:(bb.maxy-bb.miny)/2 };
        this._grabLocalFromCenter = { x: lp.x - c.x, y: lp.y - c.y };
        try { this.canvas.setPointerCapture(e.pointerId); } catch {}
        this._setCursor('move');
        return;
      } else if (h){
        this._mode = 'scale';
        this._handle = h;
        this._before = snapshotGeometry(hitText);
        try { this.canvas.setPointerCapture(e.pointerId); } catch {}
        return;
      }

      // Inside text (no handle): begin selection/caret. Do NOT start a move from inside the box.
      const idx = this._caretIndexFromPoint(world);
      hitText.caret = idx;
      if (e.shiftKey) {
        const anchor = Number.isFinite(hitText.selStart) && Number.isFinite(hitText.selEnd) && hitText.selStart !== hitText.selEnd
          ? (hitText.selStart === hitText.caret ? hitText.selEnd : hitText.selStart)
          : (hitText.selStart ?? idx);
        hitText.selStart = Math.min(anchor, idx); hitText.selEnd = Math.max(anchor, idx);
      } else { hitText.selStart = hitText.selEnd = idx; }
      this._selecting = true; this._selAnchor = hitText.selStart;
      try { this.canvas.setPointerCapture(e.pointerId); } catch {}
      layoutTextAndGrow(hitText, this.camera, this._ctx, this._blinkOn); scheduleRender();
      return;
    }

    // --- If not inside any rect, scan ALL texts' handles before drafting new ---
    {
      const arr = this.state.strokes || this.state.shapes || [];
      for (let i = arr.length - 1; i >= 0; i--){
        const s = arr[i];
        if (!s || s.shape !== 'text') continue;
        const h = hitHandleRotAware(world, s, this.camera);
        if (!h) continue;

        this._beginEditing(s);

        if (h === 'rot'){
          this._mode = 'rotate';
          this._handle = 'rot';
          const bb = bboxOf(s);
          this._rotPivot = { x:(bb.minx+bb.maxx)/2, y:(bb.miny+bb.maxy)/2 };
          this._rotAngle0 = Math.atan2(world.y - this._rotPivot.y, world.x - this._rotPivot.x);
          this._before = snapshotGeometry(s);
          try { this.canvas.setPointerCapture(e.pointerId); } catch {}
          return;
        } else if (h === 'move'){
          this._mode = 'move';
          this._handle = 'move';
          const bb = bboxOf(s);
          const c  = { x:(bb.minx+bb.maxx)/2, y:(bb.miny+bb.maxy)/2 };
          const lp = invRotateAround(world, c, s.rotation||0);
          this._before = snapshotGeometry(s);
          this._half = { x:(bb.maxx-bb.minx)/2, y:(bb.maxy-bb.miny)/2 };
          this._grabLocalFromCenter = { x: lp.x - c.x, y: lp.y - c.y };
          try { this.canvas.setPointerCapture(e.pointerId); } catch {}
          this._setCursor('move');
          return;
        } else {
          this._mode = 'scale';
          this._handle = h;
          this._before = snapshotGeometry(s);
          try { this.canvas.setPointerCapture(e.pointerId); } catch {}
          return;
        }
      }
    }

    // --- Nothing hit at all ---
    if ((e.detail || 0) >= 2) {
      try { this._finishEditing(true); } catch {}
      const s = this._newTextShapeAt(world);
      this._beginEditing(s);
      scheduleRender();
      return;
    }
  }

  onPointerMove(e){
    const r = this.canvas.getBoundingClientRect();
    const screen = { x: e.clientX - r.left, y: e.clientY - r.top };
    const world  = this.camera.screenToWorld(screen);

    if (this._drafting && this._active){
      const dx = Math.abs(screen.x - this._downScreen.x);
      const dy = Math.abs(screen.y - this._downScreen.y);
      if (dx >= MIN_DRAG_PX || dy >= MIN_DRAG_PX){
        updateShapeEnd(this._active, world);
        ensureMinBox(this._active, this.camera);
        layoutTextAndGrow(this._active, this.camera, this._ctx, this._blinkOn);
        scheduleRender();
      }
      return;
    }

    if (this._selecting && this._active){
      // Only update selection while primary button is held
      if (!(e.buttons & 1)) { this._selecting = false; this._selAnchor = null; return; }
      const idx = this._caretIndexFromPoint(world);
      const s = this._active;
      s.caret = idx;
      const anchor = Number.isFinite(this._selAnchor) ? this._selAnchor : (s.selStart ?? idx);
      s.selStart = Math.min(anchor, idx); s.selEnd = Math.max(anchor, idx);
  // selection update
      layoutTextAndGrow(s, this.camera, this._ctx, this._blinkOn); scheduleRender();
      return;
    }
    if (this._active && this._before){
      const s = this._active;

      // restore geometry from snapshot
      if (this._before.kind === 'shape'){
        s.start = { ...this._before.start };
        s.end   = { ...this._before.end };
        s.rotation = this._before.rotation || s.rotation || 0;
      }

      if (this._mode === 'move'){
        const bb0 = this._before.bbox;
        const rot = s.rotation || 0;

        // rotate local grab vector back to WORLD to find the new center
        const L = this._grabLocalFromCenter || { x:0, y:0 };
        const cos = Math.cos(rot), sin = Math.sin(rot);
        const Lw = { x: cos*L.x - sin*L.y, y: sin*L.x + cos*L.y };

        // new center so that grabbed point stays under cursor
        const C = { x: world.x - Lw.x, y: world.y - Lw.y };

        // keep original half extents from pointer-down for stable feel
        const hx = this._half?.x ?? ( (bb0.maxx - bb0.minx) * 0.5 );
        const hy = this._half?.y ?? ( (bb0.maxy - bb0.miny) * 0.5 );

        s.start.x = C.x - hx; s.start.y = C.y - hy;
        s.end.x   = C.x + hx; s.end.y   = C.y + hy;
      }
        else if (this._mode === 'scale'){
        // Scale the LOCAL, unrotated rect (correct for rotated boxes)
        const bbLocal0 = {
          minx: Math.min(this._before.start.x, this._before.end.x),
          miny: Math.min(this._before.start.y, this._before.end.y),
          maxx: Math.max(this._before.start.x, this._before.end.x),
          maxy: Math.max(this._before.start.y, this._before.end.y),
        };
        const c   = { x:(bbLocal0.minx+bbLocal0.maxx)/2, y:(bbLocal0.miny+bbLocal0.maxy)/2 };
        // Convert world move to LOCAL coordinates for handle math
        const wl = invRotateAround(world, c, s.rotation||0);
        const bbN = scaleBBoxFromHandle(this._handle, bbLocal0, wl, !!e.shiftKey, !!(e.altKey || e.metaKey));
        s.start.x = bbN.minx; s.start.y = bbN.miny;
        s.end.x   = bbN.maxx; s.end.y   = bbN.maxy;
        ensureMinBox(s, this.camera);
      } else if (this._mode === 'rotate'){
        const pivot = this._rotPivot || { x: (this._before.bbox.minx + this._before.bbox.maxx)/2, y: (this._before.bbox.miny + this._before.bbox.maxy)/2 };
        const aNow = Math.atan2(world.y - pivot.y, world.x - pivot.x);
        let dAng = aNow - this._rotAngle0;
        if (e.shiftKey){ const snap = Math.PI/12; dAng = Math.round(dAng/snap)*snap; }
        s.rotation = (this._before.rotation || 0) + dAng;
      }

      // NOTE: never change font size during transforms; wrapping updates as width changes
      const now=performance.now();
      if (!this._lastLayoutAt || now - this._lastLayoutAt > 16){
        this._lastLayoutAt = now;
        layoutTextAndGrow(s, this.camera, this._ctx, this._blinkOn);
      }
      markDirty(); scheduleRender();
      return;
    }
  }

  onPointerUp(e){
    if (e.button !== 0) return;
    // End any selection drag
    this._selecting = false; this._selAnchor = null;
    this._setCursor(this._cursorForHandle(this._hoverHandle));

    if (this._drafting){
      const s = this._active;
      const r = this.canvas.getBoundingClientRect();
      const upScreen = { x: e.clientX - r.left, y: e.clientY - r.top };
      const dx = Math.abs(upScreen.x - this._downScreen.x);
      const dy = Math.abs(upScreen.y - this._downScreen.y);
      if (dx < MIN_DRAG_PX && dy < MIN_DRAG_PX && s){
        const wWorld = scrPxToWorld(DEFAULT_BOX_W_SCR, this.camera);
        const fsWorld = scrPxToWorld(DEFAULT_FS_SCR, this.camera);
        const lhMul = s.lineHeight ?? 1.25;
        const hWorld = Math.max(scrPxToWorld(BOX_MIN_H_SCR, this.camera), lhMul * fsWorld + scrPxToWorld(16, this.camera));
        s.start.x = this._downWorld.x; s.start.y = this._downWorld.y;
        s.end.x   = this._downWorld.x + wWorld; s.end.y = this._downWorld.y + hWorld;
        ensureMinBox(s, this.camera);
        layoutTextAndGrow(s, this.camera, this._ctx, this._blinkOn);
        scheduleRender();
      }
      this.state.history?.pushAdd?.(s);
      setDeferIndex(false);
      try { this.canvas.releasePointerCapture(e.pointerId); } catch {}
      this._drafting = false;
      this._downWorld = null; this._downScreen = null;
      try { this.state._transformActive = false; } catch {}
      try {
        this.state.selection?.clear?.();
        this.state.selection?.add?.(s);
        this.state._transformActive = true;
      } catch {}
      scheduleRender();
      return;
    }

    if (this._active && this._before){
      const s = this._active;
      updateIndex(grid, s);
      this.state.history?.pushTransform?.([{
        stroke: s,
        before: this._before,
        after:  snapshotGeometry(s)
      }]); // <-- fixed: only one closing bracket
      this._mode = null; this._handle = null;
      this._before = null; this._dragMove = null;
      try { this.canvas.releasePointerCapture(e.pointerId); } catch {}
      try { this.state._transformActive = false; } catch {}
      scheduleRender();
    }
  }

  cancel(){
    if (this._drafting && this._active) removeStroke(this.state, this._active);
    this._drafting = false;
    try { window.__dcHideTextSizeUI?.(); } catch {}
    this._downWorld = null;
    this._downScreen = null;
    this._mode = null; this._handle = null;
    this._dragMove = null; this._before = null;
    try { this.state._transformActive = false; } catch {}
    this._sessionTextBefore = null;
    scheduleRender();
    // Do not remove global listeners here; cancel() is used for pointer lifecycle and
    // may be called while the Text tool remains active (e.g., lostpointercapture).
  }
}

// helper for toolbar â€œDelete Selectedâ€ button
export function deleteSelectedText(state){
  if (!state?.selection) return;
  const toDelete = Array.from(state.selection).filter(s => s.shape === 'text');
  for (const s of toDelete) removeStroke(state, s);
  markDirty(); scheduleRender();
}

