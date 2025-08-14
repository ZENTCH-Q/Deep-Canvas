// src/tools/erase.js
import { addStroke, appendPoint } from '../strokes.js';
import { scheduleRender, setDeferIndex } from '../state.js';

import { moveTol, ensureId } from '../utils/common.js';
import { drawRing, clearOverlay } from '../utils/overlay.js';

const ZOOM_RESYNC_EPS = 0.08;

export class EraseTool {
  constructor({ canvas, overlay, camera, state }){
    this.canvas = canvas; this.overlay = overlay;
    this.camera=camera; this.state=state;
    this.cur = null; this.group=null; this.lastScreen=null;
    this._widthScaleAnchor = null;
  }
  _seedWorldWidth(){
    return parseFloat(this.state.settings.size) / this.camera.scale;
  }
  _style(worldWidth){
    return { brush: 'pen', color: '#000000', alpha: 1, w: worldWidth };
  }
  _startNewStrokeAt(worldPt){
    const next = addStroke(this.state, { mode:'erase', ...this._style(this._seedWorldWidth()), pt: worldPt });
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
      const last = { x: this.cur.pts[n-3], y: this.cur.pts[n-2] };
      this._startNewStrokeAt(last);
    }
  }

  // ---------- overlay cursor ring ----------
  _ringClear(){ clearOverlay(this.overlay, this.state); }
  _ringDraw(clientX, clientY){
    const rPx = Math.max(1, parseFloat(this.state?.settings?.size) || 6);
    drawRing(this.overlay, clientX, clientY, rPx, '#ffffff99');
  }
  // -----------------------------------------

  onPointerDown(e){
    if (e.button!==0) return;
    this.state._erasingActive = true;

    setDeferIndex(true);

    this.canvas.setPointerCapture(e.pointerId);
    const r = this.canvas.getBoundingClientRect();
    const screen = { x: e.clientX - r.left, y: e.clientY - r.top };
    const world  = this.camera.screenToWorld(screen);

    this.group = [];
    this._startNewStrokeAt(world);
    this.lastScreen = screen;
    this._ringDraw(e.clientX, e.clientY);
    scheduleRender();
  }

  onPointerMove(e){
    if (!this.cur) return;
    if (e.buttons & 4) return;

    this._resyncWidthIfZoomChanged();

    const r = this.canvas.getBoundingClientRect();
    const events = e.getCoalescedEvents?.() ?? [e];

    for (const ev of events){
      const screen = { x: ev.clientX - r.left, y: ev.clientY - r.top };
      const dx = screen.x - this.lastScreen.x, dy = screen.y - this.lastScreen.y;
      const tol = moveTol(this.camera);
      if ((dx*dx + dy*dy) < tol*tol) continue;

      const world = this.camera.screenToWorld(screen);
      appendPoint(this.cur, world);
      this.lastScreen = screen;
    }

    this._ringDraw(e.clientX, e.clientY);
    scheduleRender();
  }

  onPointerUp(e){
    if (e.button !== 0) return;
    if (!this.group) return;
    if (this.group.length === 1) this.state.history?.pushAdd?.(this.group[0]);
    else this.state.history?.pushAddGroup?.(this.group);

    setDeferIndex(false);
    this.cur=null; this.group=null; this.lastScreen=null;
    this._widthScaleAnchor = null;
    this.state._erasingActive = false;

    this._ringClear();
    scheduleRender();
  }

  cancel(){
    setDeferIndex(false);
    this.cur=null; this.group=null; this.lastScreen=null;
    this._widthScaleAnchor = null;
    this.state._erasingActive = false;
    this._ringClear();
  }
}
