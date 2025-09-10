// src/tools/shapes.js

import { addShape, updateShapeEnd } from '../strokes.js';
import { scheduleRender, setDeferIndex } from '../state.js';
import { applyBrushStyle, strokeCommonSetup } from '../renderer.js';
import { hitSelectionUI } from './select.js';

import { DPR_CAP, moveTol } from '../utils/common.js';

function styleFromState(state, worldWidth) {
  const a = (typeof state?.settings?.opacity === 'number') ? state.settings.opacity : 1;
  const alpha = Math.max(0.05, Math.min(1, a));
  return { brush: state.brush, color: state.settings.color, alpha, w: worldWidth, fill: !!state.settings.fill };
}
function shapeTooSmall(s, camera) {
  const min = 2 / Math.max(1e-8, camera.scale);  // ~2px in screen space
  if (!s) return true;
  if (s.shape === 'line') {
    const dx = s.end.x - s.start.x, dy = s.end.y - s.start.y;
    return Math.hypot(dx, dy) < min;
  }
  // rect / ellipse
  const w = Math.abs(s.end.x - s.start.x);
  const h = Math.abs(s.end.y - s.start.y);
  return (w < min && h < min); // both tiny -> treat as click
}
function startShape(shape, camera, state, canvas, e) {
  if (e.button !== 0) return null;
  try { canvas.setPointerCapture(e.pointerId); } catch {}
  const r = canvas.getBoundingClientRect();
  const screen = { x: e.clientX - r.left, y: e.clientY - r.top };
  const w0 = camera.screenToWorld(screen);
  const ww = parseFloat(state.settings.size || 1) / Math.max(1e-8, camera.scale);
  const s = addShape(state, { shape, ...styleFromState(state, ww), start: w0, end: { ...w0 } });
  if (!s.id) s.id = (crypto?.randomUUID?.() || ('s-' + Math.random().toString(36).slice(2, 10)));
  return s;
}

  function moveShape(shape, camera, state, canvas, e, constrain = false) {
  const r = canvas.getBoundingClientRect();
  let w = camera.screenToWorld({ x: e.clientX - r.left, y: e.clientY - r.top });

  if (constrain) {
    if (shape.shape === 'line') {
      // Snap to 45° increments
      const dx = w.x - shape.start.x, dy = w.y - shape.start.y;
      const ang = Math.atan2(dy, dx);
      const snap = Math.round(ang / (Math.PI / 4)) * (Math.PI / 4);
      const len = Math.hypot(dx, dy);
      w = { x: shape.start.x + Math.cos(snap) * len, y: shape.start.y + Math.sin(snap) * len };
    } else {
      // Rect/Ellipse: make square/circle by locking the longer delta
      const dx = w.x - shape.start.x, dy = w.y - shape.start.y;
      const m = Math.max(Math.abs(dx), Math.abs(dy));
      w = { x: shape.start.x + Math.sign(dx) * m, y: shape.start.y + Math.sign(dy) * m };
    }
  }

  updateShapeEnd(shape, w);
  scheduleRender();
}

/**
 * Base class shared by line/rect/ellipse tools:
 * - Uses a snapshot for "live only" drawing while dragging (fast + flicker-free).
 * - Matches renderer.js compositing (glow pre-pass, fill behavior, min world sizes).
 * - Defers spatial index updates during drag, resumes/populates history on release.
 */
class BaseShapeTool {
  constructor({ canvas, ctx, camera, state }) {
    this.canvas = canvas;
    this.ctx = ctx;
    this.camera = camera;
    this.state = state;

    this.shape = null;
    this.shift = false;
    this.dragging = false;
    this.lastScreen = null;

    this._snapshot = null;
    this._haveSnapshot = false;
  }

  get shapeKind() { return 'line'; } // override in subclasses

  async _takeSnapshot() {
    // Snapshot current canvas so we can draw only the live shape on top.
    try {
      this._snapshot = await createImageBitmap(this.canvas);
      this._haveSnapshot = true;
    } catch {
      this._snapshot = null;
      this._haveSnapshot = false;
    }
  }

  _drawLiveOnly() {
    // If no snapshot, just let the global renderer paint everything.
    if (!this._haveSnapshot || !this.shape) { scheduleRender(); return; }

    const dpr = Math.min(DPR_CAP, Math.max(1, window.devicePixelRatio || 1));
    const cw = Math.floor(this.canvas.clientWidth * dpr);
    const ch = Math.floor(this.canvas.clientHeight * dpr);

    // Reset to screen space and paint snapshot
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, cw, ch);
    if (this._snapshot) this.ctx.drawImage(this._snapshot, 0, 0);

    // Switch to world space
    this.ctx.setTransform(
      dpr * this.camera.scale, 0, 0,
      dpr * this.camera.scale,
      dpr * this.camera.tx, dpr * this.camera.ty
    );

    const s = this.shape;

    // Match renderer brush/compositing so live preview equals final result
    applyBrushStyle(this.ctx, this.camera, s, /*fast=*/false, dpr);
    strokeCommonSetup(this.ctx, this.camera, s, /*fast=*/false);

    const baseW = Math.max(0.75 / Math.max(1, this.camera.scale), (s.w || 1));
    this.ctx.lineWidth = baseW;

    // Fill style (if needed); compositing already configured above.
    if (s.fill && s.mode !== 'erase') {
      this.ctx.fillStyle = s.color;
    }

    // Helper to draw one stroke pass for the shape in world coordinates.
    const drawOnce = () => {
      const a = s.start, b = s.end;

      if (s.shape === 'line') {
        this.ctx.beginPath();
        this.ctx.moveTo(a.x, a.y);
        this.ctx.lineTo(b.x, b.y);
        this.ctx.stroke();
        // Arrowhead preview
        if (s.arrow) {
          const dx = b.x - a.x, dy = b.y - a.y;
          const len = Math.hypot(dx, dy) || 1;
          const ux = dx / len, uy = dy / len;
          const size = Math.max(3 / Math.max(1, this.camera.scale), (s.w || 1) * 4);
          const baseX = b.x - ux * size;
          const baseY = b.y - uy * size;
          const perpX = -uy, perpY = ux;
          const wing = size * 0.6;
          this.ctx.beginPath();
          this.ctx.moveTo(b.x, b.y);
          this.ctx.lineTo(baseX + perpX * wing, baseY + perpY * wing);
          this.ctx.moveTo(b.x, b.y);
          this.ctx.lineTo(baseX - perpX * wing, baseY - perpY * wing);
          this.ctx.stroke();
        }
        return;
      }

      if (s.shape === 'rect') {
        let x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
        let w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
        // Enforce a tiny minimum in world units to avoid collapsing/stroking artifacts
        const minWorld = 0.5 / Math.max(1e-8, this.camera.scale);
        const cx = x + w / 2, cy = y + h / 2;
        if (w < minWorld) { w = minWorld; x = cx - w / 2; }
        if (h < minWorld) { h = minWorld; y = cy - h / 2; }
        if (s.fill && s.mode !== 'erase') {
          this.ctx.fillRect(x, y, w, h);
        }
        this.ctx.strokeRect(x, y, w, h);
        return;
      }

      if (s.shape === 'ellipse') {
        const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
        const minWorld = 0.5 / Math.max(1e-8, this.camera.scale);
        const rx0 = Math.abs(b.x - a.x) / 2;
        const ry0 = Math.abs(b.y - a.y) / 2;
        const rx = Math.max(minWorld, rx0);
        const ry = Math.max(minWorld, ry0);

        this.ctx.beginPath();
        this.ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
        if (s.fill && s.mode !== 'erase') {
          this.ctx.fill();
        }
        this.ctx.stroke();
        return;
      }
    };

    // Match glow double-pass behavior from renderer.js (if not erasing)
    if (!s || s.mode !== 'erase') {
      if (s.brush === 'glow') {
        const sa = this.ctx.globalAlpha, lw = this.ctx.lineWidth;
        this.ctx.globalAlpha = Math.min(1, sa * 0.6);
        this.ctx.lineWidth = lw * 1.8;
        drawOnce();
        this.ctx.globalAlpha = sa; this.ctx.lineWidth = lw;
      }
    }

    drawOnce();

    // Reset any canvas state we tweaked
    try { this.ctx.lineDashOffset = 0; } catch {}
    try { this.ctx.setLineDash([]); } catch {}
    this.ctx.shadowBlur = 0;
    try { this.ctx.filter = 'none'; } catch {}
    this.ctx.globalAlpha = 1;
    this.ctx.globalCompositeOperation = 'source-over';
  }

  onPointerDown(e) {
    if (e.button !== 0) return;
    {
      const r = this.canvas.getBoundingClientRect();
      const screen = { x: e.clientX - r.left, y: e.clientY - r.top };
      const world  = this.camera.screenToWorld(screen);
      const hit = hitSelectionUI(world, this.state, this.camera);
      if (hit) {
        // If user clicks on selection UI (handles/inside), delegate to Select for transform
        this._delegatedToSelect = true;
        try { this.state.setTool?.('select'); } catch {}
        this.state.tool = 'select';
        this.state._selectToolSingleton?.onPointerDown?.(e);
        return;
      } else if (this.state.selection && this.state.selection.size) {
        // Clicked outside selection UI: clear selection so user can keep drawing
        try { this.state.selection.clear(); } catch {}
        this.state._transformActive = false;
        scheduleRender();
      }
    }
    this.shift = !!e.shiftKey;
    this.dragging = false;

    setDeferIndex(true); // avoid reindex spam while dragging a shape

    this.shape = startShape(this.shapeKind, this.camera, this.state, this.canvas, e);
    if (!this.shape) { setDeferIndex(false); return; }

    // Remember last screen for movement tolerance
    const r = this.canvas.getBoundingClientRect();
    this.lastScreen = { x: e.clientX - r.left, y: e.clientY - r.top };

    // Prepare a live snapshot so we can overdraw only the shape while moving
    this._haveSnapshot = false;
    this._delegatedToSelect = false;
    this._takeSnapshot();

    scheduleRender();
  }

  onPointerMove(e) {
   if (this._delegatedToSelect) {
     this.state._selectToolSingleton?.onPointerMove?.(e);
     return;
   }
    if (!this.shape) return;

    const r = this.canvas.getBoundingClientRect();
    const scr = { x: e.clientX - r.left, y: e.clientY - r.top };
    const dx = scr.x - this.lastScreen.x, dy = scr.y - this.lastScreen.y;

    // Avoid super high-frequency geometry updates for tiny moves
    const tol = moveTol(this.camera);
    if ((dx * dx + dy * dy) < tol * tol) return;

    this.dragging = true;
    this.shift = !!e.shiftKey;

    moveShape(this.shape, this.camera, this.state, this.canvas, e, this.shift);

    // Live-only draw for responsiveness; full scene will render on release
    this._drawLiveOnly();
    this.lastScreen = scr;
  }

  onPointerUp(e) {
   if (this._delegatedToSelect) {
     this.state._selectToolSingleton?.onPointerUp?.(e);
     this._delegatedToSelect = false;
     return;
   }
    if (e.button !== 0) return;
    if (!this.shape) return;

    // One compact history entry
    const tooSmall = !this.dragging || shapeTooSmall(this.shape, this.camera);
    if (tooSmall) {
      // Remove the provisional shape we added in onPointerDown
      const i = this.state.strokes.indexOf(this.shape);
      if (i !== -1) this.state.strokes.splice(i, 1);
      try { this.canvas.releasePointerCapture(e.pointerId); } catch {}
      setDeferIndex(false); // nothing to index
      try { this._snapshot?.close?.(); } catch {}
      this._snapshot = null; this._haveSnapshot = false;
      this.shape = null; this.dragging = false; this.lastScreen = null;
      scheduleRender();
      return;
    }

    // One compact history entry (real draw)
    this.state.history?.pushAdd?.(this.shape);

    // Keep drawing: keep current tool, but briefly select the new shape so the box is visible.
    try {
      this.state.selection?.clear?.();
      this.state.selection?.add?.(this.shape);
      this.state._transformActive = false; // show box, but do not enter transform mode
    } catch {}
    this.state._hoverHandle = null;
    this.state._activeHandle = null;

    // Clean up
    try { this.canvas.releasePointerCapture(e.pointerId); } catch {}
    setDeferIndex(false);

    // Release snapshot and force a full render
    try { this._snapshot?.close?.(); } catch {}
    this._snapshot = null;
    this._haveSnapshot = false;

    this.shape = null;
    this.dragging = false;
    this.lastScreen = null;

    scheduleRender();
  }

  cancel() {
    this._delegatedToSelect = false;
    try { this._snapshot?.close?.(); } catch {}
    this._snapshot = null;
    this._haveSnapshot = false;

    setDeferIndex(false);
    this.shape = null;
    this.dragging = false;
    this.lastScreen = null;

    scheduleRender();
  }
}

export class LineTool extends BaseShapeTool {
  get shapeKind() { return 'line'; }
}

export class RectTool extends BaseShapeTool {
  get shapeKind() { return 'rect'; }
}

export class EllipseTool extends BaseShapeTool {
  get shapeKind() { return 'ellipse'; }
}

export class ArrowTool extends BaseShapeTool {
  get shapeKind() { return 'line'; }
  onPointerDown(e) {
    super.onPointerDown(e);
    if (this.shape) this.shape.arrow = true;
  }
}
