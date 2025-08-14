// src/tools/pan.js
import { scheduleRender } from '../state.js';
import { renormalizeIfNeeded, whenRenormalized } from '../camera.js';
import { rebuildIndex, grid } from '../spatial_index.js';
import { render } from '../renderer.js';

const PAN_REFRESH_MS = 140; 
const PAN_IDLE_MS    = 100;

export class PanTool {
  constructor({ canvas, overlay, camera, state, onRenormStart, onRenormEnd }){
    this.canvas  = canvas;
    this.overlay = overlay; 
    this.camera  = camera;
    this.state   = state;

    this.drag = false; this.last = { x:0, y:0 }; this.activeButton = null;
    this.onRenormStart = onRenormStart || (()=>{});
    this.onRenormEnd   = onRenormEnd   || (()=>{});
    this._idleTimer = 0;
    this._lastRefresh = 0;
    this._camBase = { tx:0, ty:0 }; 
    this._lastMoveT = 0;
    this._vx = 0; this._vy = 0;
  }

  _showOverlaySnapshot(){
    if (!this.overlay) return;
    if (this.overlay.width !== this.canvas.width || this.overlay.height !== this.canvas.height){
      this.overlay.width  = this.canvas.width;
      this.overlay.height = this.canvas.height;
      this.overlay.style.width  = this.canvas.clientWidth + 'px';
      this.overlay.style.height = this.canvas.clientHeight + 'px';
    }

    const octx = this.overlay.getContext('2d', { alpha: true });
    octx.setTransform(1,0,0,1,0,0);
    octx.clearRect(0,0,this.overlay.width,this.overlay.height);
    octx.drawImage(this.canvas, 0, 0);

    this.overlay.style.display = 'block';
    this.overlay.style.transform = 'translate3d(0px,0px,0)';
    this.canvas.style.visibility = 'hidden';
  }
  _hideOverlay(){
    if (!this.overlay) return;
    this.overlay.style.display = 'none';
    this.overlay.style.transform = 'translate3d(0px,0px,0)';
    this.canvas.style.visibility = '';
  }
  _repaintOverlayNow(){
    if (!this.overlay) return;
    const octx = this.overlay.getContext('2d', { alpha: true });
    render(this.state, this.camera, octx, this.overlay, { dpr: 1, skipSnapshotPath: true });
    this._camBase.tx = this.camera.tx;
    this._camBase.ty = this.camera.ty;
    this.overlay.style.transform = 'translate3d(0px,0px,0)';
  }

  _debouncedHeavyWork(){
    const s = this.state;
    const started = renormalizeIfNeeded(this.camera, s.strokes, { budgetMs: 4 }, s);
    if (started) this.onRenormStart();
    whenRenormalized()
      .then(() => { if (started) rebuildIndex(grid, s.strokes); })
      .finally(() => { if (started) this.onRenormEnd(); });
  }

  onPointerDown(e){
    if (this.state._drawingActive || this.state._erasingActive) return;

    const canPan = (this.state.tool === 'pan') || (e.button === 1);
    if (!canPan) return;

    this.drag = true;
    this.activeButton = e.button;
    this.canvas.classList.add('dragging');
    this.last = { x: e.clientX, y: e.clientY };
    this.canvas.setPointerCapture(e.pointerId);

    this._showOverlaySnapshot();
    this._camBase.tx = this.camera.tx;
    this._camBase.ty = this.camera.ty;
    this._lastRefresh = performance.now();
    this._lastMoveT   = this._lastRefresh;
    this._vx = 0; this._vy = 0;
  }

  onPointerMove(e){
    if (!this.drag) return;
    if (this.state._drawingActive || this.state._erasingActive) return;

    if (this.state.tool !== 'pan') {
      const stillHoldingMiddle = !!(e.buttons & 4); 
      if (this.activeButton === 1 && !stillHoldingMiddle) { this.onPointerUp({ button: 1 }); return; }
    }

    const nowT = performance.now();
    const dx = e.clientX - this.last.x;
    const dy = e.clientY - this.last.y;
    const dt = Math.max(1, nowT - (this._lastMoveT || nowT));
    this._vx = (0.8*this._vx) + (0.2 * dx/dt);
    this._vy = (0.8*this._vy) + (0.2 * dy/dt);
    this._lastMoveT = nowT;

    this.camera.tx += dx;
    this.camera.ty += dy;

    if (!Number.isFinite(this.camera.tx) || !Number.isFinite(this.camera.ty)) {
      this.camera.tx = 0; this.camera.ty = 0;
    }

    this.last = { x: e.clientX, y: e.clientY };
    const offx = Math.round(this.camera.tx - this._camBase.tx);
    const offy = Math.round(this.camera.ty - this._camBase.ty);
    if (this.overlay){
      this.overlay.style.transform = `translate3d(${offx}px, ${offy}px, 0)`;
    }

    const speed = Math.min(2.5, Math.hypot(this._vx, this._vy)); 
    const dynPeriod = Math.max(60, PAN_REFRESH_MS - speed*20);  // repaint overlay less aggressively while moving fast
    const now = performance.now();
    if (now - this._lastRefresh >= dynPeriod) {
      this._repaintOverlayNow();
      this._lastRefresh = now;
    }

    clearTimeout(this._idleTimer);
    this._idleTimer = setTimeout(() => this._debouncedHeavyWork(), PAN_IDLE_MS);
  }

  onPointerUp(e){
    if (!this.drag) return;
    if (e.button !== this.activeButton) return;

    this.drag = false;
    this.activeButton = null;
    this.canvas.classList.remove('dragging');

    clearTimeout(this._idleTimer);
    this._debouncedHeavyWork(); 

    this._hideOverlay();
    scheduleRender();
  }

  cancel(){
    this.drag = false;
    this.activeButton = null;
    this.canvas.classList.remove('dragging');

    clearTimeout(this._idleTimer);
    this._hideOverlay();
  }
}