// src/tools/delete.js
import { scheduleRender, state as globalState } from '../state.js';
import { removeStroke } from '../strokes.js';

import { pickRadius } from '../utils/pick.js';
import { pickTopAt } from '../utils/picker.js';

export class DeleteTool {
  constructor({ canvas, camera, state }){
    this.canvas = canvas; this.camera = camera; this.state = state;

    // scrub-delete session state
    this._active = false;
    this._deleted = [];
    this._deletedIdx = [];
    this._seen = new Set();
  }

  _pickAt(world, pickR){
    return pickTopAt(world, pickR, { camera: this.camera, state: this.state, bake: globalState._bake });
  }

  _tryDeleteAt(world, pickR){
    const target = this._pickAt(world, pickR);
    if (!target) return;

    if (this._seen.has(target)) return;
    const idx = this.state.strokes.indexOf(target);
    if (idx === -1) return; // already gone

    this._seen.add(target);
    removeStroke(this.state, target);
    this._deleted.push(target);
    this._deletedIdx.push(idx);
    scheduleRender();
  }

  onPointerDown(e){
    if (!(e.button === 0 || e.buttons === 1)) return;
    this._active = true;
    this._deleted = [];
    this._deletedIdx = [];
    this._seen.clear();

    try { this.canvas.setPointerCapture(e.pointerId); } catch {}
    const rct = this.canvas.getBoundingClientRect();
    const screen = { x: e.clientX - rct.left, y: e.clientY - rct.top };
    const world  = this.camera.screenToWorld(screen);

    const pickR = pickRadius(this.camera, this.state);

    this._tryDeleteAt(world, pickR);
  }

  onPointerMove(e){
    if (!this._active) return;
    if (!(e.buttons & 1)) return; // only while holding primary

    const rct = this.canvas.getBoundingClientRect();
    const events = e.getCoalescedEvents?.() ?? [e];

    const pickR = pickRadius(this.camera, this.state);

    for (const ev of events){
      const screen = { x: ev.clientX - rct.left, y: ev.clientY - rct.top };
      const world  = this.camera.screenToWorld(screen);
      this._tryDeleteAt(world, pickR);
    }
  }

  onPointerUp(e){
    if (e.button !== 0) return;
    if (!this._active) return;

    // one compact history entry
    if (this._deleted.length === 1){
      this.state.history?.pushDelete?.(this._deleted[0], this._deletedIdx[0]);
    } else if (this._deleted.length > 1){
      this.state.history?.pushDeleteGroup?.(this._deleted, this._deletedIdx);
    }

    this._active = false;
    scheduleRender();
  }

  cancel(){
    this._active = false;
  }
}
