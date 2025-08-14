//src/tools/shapes.js

import { addShape, updateShapeEnd } from '../strokes.js';
import { scheduleRender, setDeferIndex } from '../state.js';
import { applyBrushStyle, strokeCommonSetup } from '../renderer.js';

import { DPR_CAP, moveTol } from '../utils/common.js';

function styleFromState(state, worldWidth) {
  const alpha = (typeof state.settings.opacity === 'number') ? state.settings.opacity : 1;
  return { brush: state.brush, color: state.settings.color, alpha, w: worldWidth, fill: !!state.settings.fill };
}

function startShape(shape, tool, camera, state, canvas, e) {
  if (e.button !== 0) return null;
  canvas.setPointerCapture(e.pointerId);
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
      const dx = w.x - shape.start.x, dy = w.y - shape.start.y;
      const ang = Math.atan2(dy, dx), snap = Math.round(ang / (Math.PI / 4)) * (Math.PI / 4);
      const len = Math.hypot(dx, dy);
      w = { x: shape.start.x + Math.cos(snap) * len, y: shape.start.y + Math.sin(snap) * len };
    } else {
      const dx = w.x - shape.start.x, dy = w.y - shape.start.y; const m = Math.max(Math.abs(dx), Math.abs(dy));
      w = { x: shape.start.x + Math.sign(dx) * m, y: shape.start.y + Math.sign(dy) * m };
    }
  }
  updateShapeEnd(shape, w);
}

class BaseShapeTool {
  constructor({ canvas, ctx, camera, state }) {
    this.canvas = canvas;
    this.ctx = ctx;
    this.camera = camera;
    this.state = state;
    this.shape = null;
    this.shift = false;
    this.lastScreen = null;

    this._snapshot = null;
    this._haveSnapshot = false;
  }

  async _takeSnapshot() {
    try {
      this._snapshot = await createImageBitmap(this.canvas);
      this._haveSnapshot = true;
    } catch {
      this._snapshot = null;
      this._haveSnapshot = false;
    }
  }

  _drawLiveOnly() {
    if (!this._haveSnapshot || !this.shape) { scheduleRender(); return; }

    const dpr = Math.min(DPR_CAP, Math.max(1, window.devicePixelRatio || 1));
    const cw = Math.floor(this.canvas.clientWidth * dpr);
    const ch = Math.floor(this.canvas.clientHeight * dpr);

    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, cw, ch);
    this.ctx.drawImage(this._snapshot, 0, 0);

    this.ctx.setTransform(
      dpr * this.camera.scale, 0, 0,
      dpr * this.camera.scale,
      dpr * this.camera.tx, dpr * this.camera.ty
    );

    // Use the exact same brush + compositing setup as the final renderer
    applyBrushStyle(this.ctx, this.camera, this.shape, /*fast=*/false);
    strokeCommonSetup(this.ctx, this.camera, this.shape, /*fast=*/false);

    const baseW = Math.max(0.75 / Math.max(1, this.camera.scale), (this.shape.w || 1));
    this.ctx.lineWidth = baseW;

    // Fill style (if needed); compositing already set above
    if (this.shape.fill) {
      this.ctx.fillStyle = this.shape.color;
    }

    const a = this.shape.start;
    const b = this.shape.end;

    // Helper to stroke once (used for "glow" prepass)
    const strokeOnce = () => {
      if (this.shape.shape === 'line') {
        this.ctx.beginPath(); this.ctx.moveTo(a.x, a.y); this.ctx.lineTo(b.x, b.y); this.ctx.stroke();
      } else if (this.shape.shape === 'rect') {
        let x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
        let w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
        const minWorld = 0.5 / Math.max(1e-8, this.camera.scale);
        const cx = x + w / 2, cy = y + h / 2;
        if (w < minWorld) { w = minWorld; x = cx - w / 2; }
        if (h < minWorld) { h = minWorld; y = cy - h / 2; }
        this.ctx.strokeRect(x, y, w, h);
      } else if (this.shape.shape === 'ellipse') {
        const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
        const minWorld = 0.5 / Math.max(1e-8, this.camera.scale);
        const rx = Math.max(minWorld, Math.abs(b.x - a.x) / 2);
        const ry = Math.max(minWorld, Math.abs(b.y - a.y) / 2);
        this.ctx.beginPath(); this.ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
        this.ctx.stroke();
      }
    };

    // Match renderer.js: glow prepass (only stroke)
    if (this.shape.brush === 'glow') {
      const sa = this.ctx.globalAlpha, lw = this.ctx.lineWidth;
      this.ctx.globalAlpha = Math.min(1, sa * 0.6);
      this.ctx.lineWidth = lw * 1.8;
      strokeOnce();
      this.ctx.globalAlpha = sa; this.ctx.lineWidth = lw;
    }

    // Final paint (fill first if requested, then stroke — same order as renderer)
    if (this.shape.shape === 'line') {
      this.ctx.beginPath(); this.ctx.moveTo(a.x, a.y); this.ctx.lineTo(b.x, b.y);
      this.ctx.stroke();
    } else if (this.shape.shape === 'rect') {
      let x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
      let w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
      const minWorld = 0.5 / Math.max(1e-8, this.camera.scale);
      const cx = x + w / 2, cy = y + h / 2;
      if (w < minWorld) { w = minWorld; x = cx - w / 2; }
      if (h < minWorld) { h = minWorld; y = cy - h / 2; }
      if (this.shape.fill) this.ctx.fillRect(x, y, w, h);
      this.ctx.strokeRect(x, y, w, h);
    } else if (this.shape.shape === 'ellipse') {
      const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
      const minWorld = 0.5 / Math.max(1e-8, this.camera.scale);
      const rx = Math.max(minWorld, Math.abs(b.x - a.x) / 2);
      const ry = Math.max(minWorld, Math.abs(b.y - a.y) / 2);
      this.ctx.beginPath(); this.ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      if (this.shape.fill) this.ctx.fill();
      this.ctx.stroke();
    }

    // Reset to defaults
    this.ctx.globalAlpha = 1;
    this.ctx.setLineDash([]);
    this.ctx.shadowBlur = 0;
    this.ctx.globalCompositeOperation = 'source-over';
  }

  onPointerMove(e) {
    if (!this.shape) return;

    const r = this.canvas.getBoundingClientRect();
    const screen = { x: e.clientX - r.left, y: e.clientY - r.top };
    if (this.lastScreen) {
      const dx = screen.x - this.lastScreen.x, dy = screen.y - this.lastScreen.y;
      const tol = moveTol(this.camera);
      if ((dx * dx + dy * dy) < tol * tol) return;
    }
    const constrain = !!e.shiftKey;
    moveShape(this.shape, this.camera, this.state, this.canvas, e, constrain);
    this.lastScreen = screen;
    this._drawLiveOnly();
  }

  onPointerUp() {
    if (!this.shape) return;
    this.state.history?.pushAdd?.(this.shape);
    this.shape = null;
    this.lastScreen = null;
    setDeferIndex(false);
    this.state._drawingActive = false;
    scheduleRender();
    try { this._snapshot?.close?.(); } catch {}
    this._snapshot = null;
    this._haveSnapshot = false;
  }

  cancel() {
    this.shape = null;
    this.lastScreen = null;
    setDeferIndex(false);
    this.state._drawingActive = false;
    try { this._snapshot?.close?.(); } catch {}
    this._snapshot = null;
    this._haveSnapshot = false;
  }
}

export class LineTool extends BaseShapeTool {
  onPointerDown(e) {
    this.shape = startShape('line', this, this.camera, this.state, this.canvas, e);
    if (this.shape) {
      setDeferIndex(true);
      this.state._drawingActive = true;
      this.lastScreen = null;
      this._haveSnapshot = false;
      this._takeSnapshot();
    }
  }
}
export class RectTool extends BaseShapeTool {
  onPointerDown(e) {
    this.shape = startShape('rect', this, this.camera, this.state, this.canvas, e);
    if (this.shape) {
      setDeferIndex(true);
      this.state._drawingActive = true;
      this.lastScreen = null;
      this._haveSnapshot = false;
      this._takeSnapshot();
    }
  }
}
export class EllipseTool extends BaseShapeTool {
  onPointerDown(e) {
    this.shape = startShape('ellipse', this, this.camera, this.state, this.canvas, e);
    if (this.shape) {
      setDeferIndex(true);
      this.state._drawingActive = true;
      this.lastScreen = null;
      this._haveSnapshot = false;
      this._takeSnapshot();
    }
  }
}
