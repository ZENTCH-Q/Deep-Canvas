// src/tools/draw.js
import { addStroke, appendPoint } from '../strokes.js';
import { scheduleRender, setDeferIndex } from '../state.js';
import { applyBrushStyle, strokeCommonSetup } from '../renderer.js';

import { DPR_CAP, moveTol, ensureId } from '../utils/common.js';
import { drawRing, clearOverlay } from '../utils/overlay.js';

const MAX_POINTS_PER_STROKE = 20000;
const ZOOM_RESYNC_EPS = 0.08;

export class DrawTool {
  constructor({ canvas, ctx, overlay, camera, state }){
    this.canvas = canvas; this.ctx = ctx; this.overlay = overlay;
    this.camera=camera; this.state=state;
    this.cur = null; this.group = null; this.lastScreen = null;
    this._widthScaleAnchor = null;

    this._snapshot = null;
    this._haveSnapshot = false;

    this._ps = 0.5; // smoothed pressure
  }

  _commonStyle(worldWidth){
    const a = (typeof this.state?.settings?.opacity === 'number') ? this.state.settings.opacity : 1;
    const alpha = Math.max(0.05, Math.min(1, a));
    return { brush: this.state.brush, color: this.state.settings.color, alpha, w: worldWidth };
  }
  _seedWorldWidth(){ return parseFloat(this.state.settings.size) / this.camera.scale; }
  _startNewStrokeAt(worldPt){
    const style = this._commonStyle(this._seedWorldWidth());
    const next = addStroke(this.state, { mode:'draw', ...style, pt: worldPt });
    ensureId(next);
    this.cur = next;
    this.group.push(next);
    this._widthScaleAnchor = this.camera.scale;
  }
  _resyncWidthIfZoomChanged(){
    if (!this.cur) return;
    const s0 = this._widthScaleAnchor ?? this.camera.scale;
    const ratio = this.camera.scale / Math.max(1e-8, s0);
    if (ratio > (1 + ZOOM_RESYNC_EPS) || ratio < (1 - ZOOM_RESYNC_EPS)) {
      const n = this.cur.n;
      const x = this.cur.pts[n-3], y = this.cur.pts[n-2], p = this.cur.pts[n-1];
      this._startNewStrokeAt({ x, y, p });
    }
  }

  async _takeSnapshot(){
    try{
      this._snapshot = await createImageBitmap(this.canvas);
      this._haveSnapshot = true;
    } catch {
      this._snapshot = null;
      this._haveSnapshot = false;
    }
  }

  _drawLiveOnly(){
    if (!this._haveSnapshot || !this.cur) { scheduleRender(); return; }

    const dpr = Math.min(DPR_CAP, Math.max(1, window.devicePixelRatio || 1));
    const cw = Math.floor(this.canvas.clientWidth * dpr);
    const ch = Math.floor(this.canvas.clientHeight * dpr);

    this.ctx.setTransform(1,0,0,1,0,0);
    this.ctx.clearRect(0,0,cw,ch);
    this.ctx.drawImage(this._snapshot, 0, 0);

    this.ctx.setTransform(
      dpr * this.camera.scale, 0, 0,
      dpr * this.camera.scale,
      dpr * this.camera.tx, dpr * this.camera.ty
    );

    const s = this.cur;

    // Use the exact same brush + compositing setup as the final renderer
    applyBrushStyle(this.ctx, this.camera, s, /*fast=*/false);
    strokeCommonSetup(this.ctx, this.camera, s, /*fast=*/false);

    const baseW = Math.max(0.75 / Math.max(1, this.camera.scale), (s.w || 1));
    this.ctx.lineWidth = baseW;

    const pts = s.pts, n = s.n;
    if (!pts || n < 6) return;

    this.ctx.beginPath();
    this.ctx.moveTo(pts[0], pts[1]);

    const sTol = 0.75 / Math.max(1e-8, this.camera.scale);
    let lx = pts[0], ly = pts[1];
    for (let i = 3; i < n; i += 3){
      const x = pts[i], y = pts[i+1];
      const dx = x - lx, dy = y - ly;
      if ((dx*dx + dy*dy) >= sTol*sTol){ this.ctx.lineTo(x, y); lx = x; ly = y; }
    }

    // Match "glow" double-pass from renderer.js
    if (s.brush === 'glow'){
      const sa = this.ctx.globalAlpha, lw = this.ctx.lineWidth;
      this.ctx.globalAlpha = Math.min(1, sa * 0.6);
      this.ctx.lineWidth = lw * 1.8;
      this.ctx.stroke();
      this.ctx.globalAlpha = sa; this.ctx.lineWidth = lw;
    }
    this.ctx.stroke();

    // Reset to defaults
    this.ctx.setLineDash([]); this.ctx.shadowBlur = 0; this.ctx.globalAlpha = 1; this.ctx.globalCompositeOperation = 'source-over';
  }

  // ---------- overlay cursor ring ----------
  _ringClear(){ clearOverlay(this.overlay, this.state); }
  _ringDraw(clientX, clientY){
    const rPx = Math.max(1, parseFloat(this.state?.settings?.size) || 6);
    drawRing(this.overlay, clientX, clientY, rPx, '#88ccffaa');
  }
  // -----------------------------------------

  onPointerDown(e){
    if (e.button!==0) return;
    this.state._drawingActive = true;
    setDeferIndex(true);
    this.canvas.setPointerCapture(e.pointerId);
    const r = this.canvas.getBoundingClientRect();
    const screen = { x: e.clientX - r.left, y: e.clientY - r.top };
    const world  = this.camera.screenToWorld(screen);

    this.group = [];
    // initialize smoothed pressure
    const p0 = (e.pressure && e.pressure>0) ? e.pressure : 0.5;
    this._ps = p0;
    this._startNewStrokeAt({ x: world.x, y: world.y, p: this._ps });
    this.lastScreen = screen;

    this._haveSnapshot = false;
    this._takeSnapshot();

    this._ringDraw(e.clientX, e.clientY);
  }

  onPointerMove(e){
    if (!this.cur) return;
    if (e.buttons & 4) return; // middle button: panning

    this._resyncWidthIfZoomChanged();

    const r = this.canvas.getBoundingClientRect();
    const events = e.getCoalescedEvents?.() ?? [e];

    for (const ev of events){
      const screen = { x: ev.clientX - r.left, y: ev.clientY - r.top };
      const dx = screen.x - this.lastScreen.x, dy = screen.y - this.lastScreen.y;
      const tol = moveTol(this.camera);
      if ((dx*dx + dy*dy) < tol*tol) { continue; }

      const world = this.camera.screenToWorld(screen);
      const raw = (ev.pressure && ev.pressure>0) ? ev.pressure : 0.5;
      // light pressure smoothing
      this._ps = 0.7*this._ps + 0.3*raw;

      const n = this.cur.n;
      const lx = this.cur.pts[n-3], ly = this.cur.pts[n-2];
      if (world.x!==lx || world.y!==ly) appendPoint(this.cur, { x: world.x, y: world.y, p: this._ps });

      this.lastScreen = screen;
      if ((this.cur.n / 3) >= MAX_POINTS_PER_STROKE) {
        this._startNewStrokeAt({ x: world.x, y: world.y, p: this._ps });
      }
    }

    this._drawLiveOnly();
    this._ringDraw(e.clientX, e.clientY);
  }

  onPointerUp(e){
    if (e.button !== 0) return;
    if (!this.group) return;

    if (this.group.length === 1) this.state.history?.pushAdd?.(this.group[0]);
    else this.state.history?.pushAddGroup?.(this.group);

    setDeferIndex(false);

    this.cur = null; this.group = null; this.lastScreen = null;
    this._widthScaleAnchor = null;

    try { this._snapshot?.close?.(); } catch {}
    this._snapshot = null; this._haveSnapshot = false;
    this.state._drawingActive = false;

    this._ringClear();
    scheduleRender();
  }

  cancel(){
    setDeferIndex(false);
    this.cur=null; this.group=null; this.lastScreen=null;
    this._widthScaleAnchor = null;
    try { this._snapshot?.close?.(); } catch {}
    this._snapshot = null; this._haveSnapshot = false;
    this.state._drawingActive = false;

    this._ringClear();
  }
}
