// src/tools/shapes.js
import { addShape, updateShapeEnd, removeStroke, selectForTransform } from '../strokes.js';
import { scheduleRender, setDeferIndex } from '../state.js';

const MIN_DRAG_PX = 3;

function worldLineWidthFromSettings(state, camera) {
  const sizePx = Math.max(1, parseFloat(state?.settings?.size) || 1);
  return sizePx / Math.max(1e-8, camera.scale);
}

function snapAngle(dx, dy, stepRad = Math.PI / 12) { // 15° by default
  const len = Math.hypot(dx, dy) || 0;
  if (len === 0) return { x: dx, y: dy };
  const ang = Math.atan2(dy, dx);
  const a2 = Math.round(ang / stepRad) * stepRad;
  return { x: Math.cos(a2) * len, y: Math.sin(a2) * len };
}

class BaseShapeTool {
  constructor({ canvas, camera, state }) {
    this.canvas = canvas;
    this.camera = camera;
    this.state = state;
    this._active = null;
    this._downScreen = null;
    this._downWorld = null;
    this._drafting = false;
    this._prevHadSelection = false;
  }

  _newShape(shape, worldPt) {
    const s = addShape(this.state, {
      shape,
      brush: this.state?.brush || 'pen',
      color: this.state?.settings?.color || '#e6eaf0',
      alpha: (typeof this.state?.settings?.opacity === 'number') ? this.state.settings.opacity : 1,
      w: worldLineWidthFromSettings(this.state, this.camera),
      start: { x: worldPt.x, y: worldPt.y },
      end:   { x: worldPt.x, y: worldPt.y },
      fill: !!this.state?.settings?.fill
    });
    return s;
  }

  _begin(e, shape) {
    if (e.button !== 0) return;
    const r = this.canvas.getBoundingClientRect();
    const screen = { x: e.clientX - r.left, y: e.clientY - r.top };
    const world  = this.camera.screenToWorld(screen);
    this._downScreen = screen; this._downWorld = world;
    // Remember prior selection state (used to treat simple click as deselect)
    this._prevHadSelection = !!(this.state?.selection && this.state.selection.size > 0);

    // When starting to draft a new shape, hide any existing selection UI immediately
    try { this.state.selection?.clear?.(); } catch {}
    try { this.state._transformActive = false; } catch {}
    try { this.state._hoverHandle = null; this.state._activeHandle = null; } catch {}
    setDeferIndex(true);
    this._active = this._newShape(shape, world);
    try { this.canvas.setPointerCapture(e.pointerId); } catch {}
    this._drafting = true;
    scheduleRender();
  }

  _update(e, onUpdate) {
    if (!this._drafting || !this._active) return;
    const r = this.canvas.getBoundingClientRect();
    const screen = { x: e.clientX - r.left, y: e.clientY - r.top };
    const world  = this.camera.screenToWorld(screen);

    let a = { ...this._downWorld };
    let b = { ...world };

    const alt = !!(e.altKey || e.metaKey);
    const shift = !!e.shiftKey;

    if (alt) {
      const dx = world.x - this._downWorld.x;
      const dy = world.y - this._downWorld.y;
      a = { x: this._downWorld.x - dx, y: this._downWorld.y - dy };
      b = { x: this._downWorld.x + dx, y: this._downWorld.y + dy };
    }

    if (onUpdate) { ({ a, b } = onUpdate(a, b, { shift }) || { a, b }); }

    updateShapeEnd(this._active, b);
    // also update start if changed (for ALT-center)
    if (a.x !== this._active.start.x || a.y !== this._active.start.y) {
      this._active.start = { ...a };
    }
    scheduleRender();
  }

  _end(e) {
    if (e.button !== 0) return;
    if (this._drafting && this._active) {
      const r = this.canvas.getBoundingClientRect();
      const upScreen = { x: e.clientX - r.left, y: e.clientY - r.top };
      const dx = Math.abs(upScreen.x - this._downScreen.x);
      const dy = Math.abs(upScreen.y - this._downScreen.y);
      // If it was just a click, draw nothing (discard the transient shape)
      if (dx < MIN_DRAG_PX && dy < MIN_DRAG_PX) {
        try { removeStroke(this.state, this._active); } catch {}
        setDeferIndex(false);
        try { this.canvas.releasePointerCapture(e.pointerId); } catch {}
        this._drafting = false;
        this._downWorld = null; this._downScreen = null; this._active = null;
        scheduleRender();
        return;
      }
      // Commit to history and select the newly created shape
      this.state.history?.pushAdd?.(this._active);
      try { selectForTransform(this.state, this._active); } catch {}
      setDeferIndex(false);
      try { this.canvas.releasePointerCapture(e.pointerId); } catch {}
      this._drafting = false;
      this._downWorld = null; this._downScreen = null; this._active = null;
      scheduleRender();
    }
  }

  cancel() {
    if (this._drafting && this._active) {
      try { removeStroke(this.state, this._active); } catch {}
    }
    this._drafting = false; this._active = null;
    this._downWorld = null; this._downScreen = null;
    setDeferIndex(false);
    scheduleRender();
  }
}

export class LineTool extends BaseShapeTool {
  onPointerDown(e) { this._begin(e, 'line'); }
  onPointerMove(e) {
    this._update(e, (a, b, { shift }) => {
      if (!shift) return { a, b };
      const dx = b.x - a.x, dy = b.y - a.y;
      const v = snapAngle(dx, dy, Math.PI / 4); // 45° snaps
      return { a, b: { x: a.x + v.x, y: a.y + v.y } };
    });
  }
  onPointerUp(e) { this._end(e); }
}

export class RectTool extends BaseShapeTool {
  onPointerDown(e) { this._begin(e, 'rect'); }
  onPointerMove(e) {
    this._update(e, (a, b, { shift }) => {
      if (!shift) return { a, b };
      const dx = b.x - a.x, dy = b.y - a.y;
      const m = Math.max(Math.abs(dx), Math.abs(dy)) || 0;
      const sx = Math.sign(dx) || 1, sy = Math.sign(dy) || 1;
      return { a, b: { x: a.x + sx * m, y: a.y + sy * m } };
    });
  }
  onPointerUp(e) { this._end(e); }
}

export class EllipseTool extends BaseShapeTool {
  onPointerDown(e) { this._begin(e, 'ellipse'); }
  onPointerMove(e) {
    this._update(e, (a, b, { shift }) => {
      if (!shift) return { a, b };
      const dx = b.x - a.x, dy = b.y - a.y;
      const m = Math.max(Math.abs(dx), Math.abs(dy)) || 0;
      const sx = Math.sign(dx) || 1, sy = Math.sign(dy) || 1;
      return { a, b: { x: a.x + sx * m, y: a.y + sy * m } };
    });
  }
  onPointerUp(e) { this._end(e); }
}

// ArrowTool: alias LineTool (renderer draws 'line')
export class ArrowTool extends LineTool {}
