// src/tools/select.js
import { scheduleRender, state as globalState, setDeferIndex } from '../state.js';
import { query, grid, update } from '../spatial_index.js';
import { transformStrokeGeom, snapshotGeometry } from '../strokes.js';

import { pointInRect } from '../utils/common.js';
import { pickRadius, handleWorldRadius } from '../utils/pick.js';
import { pickTopAt } from '../utils/picker.js';

const MOVE_TOL_SQ = 4 * 4;

function rectFrom(a, b){
  return { minx: Math.min(a.x,b.x), miny: Math.min(a.y,b.y), maxx: Math.max(a.x,b.x), maxy: Math.max(a.y,b.y) };
}
function bboxContains(outer, inner){
  return outer.minx <= inner.minx && outer.miny <= inner.miny &&
         outer.maxx >= inner.maxx && outer.maxy >= inner.maxy;
}

function selectionBBoxWorld(state){
  const bake = globalState._bake;
  let minx=Infinity, miny=Infinity, maxx=-Infinity, maxy=-Infinity;
  for (const s of state.selection){
    const b = s.bbox;
    if (!b) continue;
    let bb = b;
    if (bake?.active && s._baked === false){
      const s0=bake.s, tx=bake.tx, ty=bake.ty;
      bb = { minx: b.minx*s0+tx, miny: b.miny*s0+ty, maxx: b.maxx*s0+tx, maxy: b.maxy*s0+ty };
    }
    if (bb.minx < minx) minx = bb.minx;
    if (bb.miny < miny) miny = bb.miny;
    if (bb.maxx > maxx) maxx = bb.maxx;
    if (bb.maxy > maxy) maxy = bb.maxy;
  }
  if (!Number.isFinite(minx)) return null;
  return { minx, miny, maxx, maxy };
}

function hitHandle(worldPt, bbox, camera){
  if (!bbox) return null;
  const r = handleWorldRadius(camera);
  const hs = r; 
  const cx = (bbox.minx + bbox.maxx) / 2;
  const cy = (bbox.miny + bbox.maxy) / 2;
  const corners = {
    nw: { x:bbox.minx, y:bbox.miny },
    ne: { x:bbox.maxx, y:bbox.miny },
    se: { x:bbox.maxx, y:bbox.maxy },
    sw: { x:bbox.minx, y:bbox.maxy },
  };
  const mids = {
    n: { x:cx,         y:bbox.miny },
    e: { x:bbox.maxx,  y:cy },
    s: { x:cx,         y:bbox.maxy },
    w: { x:bbox.minx,  y:cy },
  };

  const rotOffsetWorld = 28 / Math.max(1e-8, camera.scale);
  const rot = { x: cx, y: bbox.miny - rotOffsetWorld };

  const dxr = worldPt.x - rot.x, dyr = worldPt.y - rot.y;
  if ((dxr*dxr + dyr*dyr) <= (r * r)) return 'rot';

  const all = { ...corners, ...mids };
  for (const [k,p] of Object.entries(all)){
    const aabb = { minx:p.x-hs, miny:p.y-hs, maxx:p.x+hs, maxy:p.y+hs };
    if (worldPt.x >= aabb.minx && worldPt.x <= aabb.maxx &&
        worldPt.y >= aabb.miny && worldPt.y <= aabb.maxy) {
      return k;
    }
  }
  return null;
}

function scaleFromHandle(handle, bb, cursor, shiftUniform, altCenter){
  const cx = (bb.minx + bb.maxx) / 2, cy = (bb.miny + bb.maxy) / 2;
  let ox = cx, oy = cy;
  if (!altCenter){
    switch (handle){
      case 'nw': ox = bb.maxx; oy = bb.maxy; break;
      case 'ne': ox = bb.minx; oy = bb.maxy; break;
      case 'se': ox = bb.minx; oy = bb.miny; break;
      case 'sw': ox = bb.maxx; oy = bb.miny; break;
      case 'e':  ox = bb.minx; oy = cy;      break;
      case 'w':  ox = bb.maxx; oy = cy;      break;
      case 'n':  ox = cx;      oy = bb.maxy; break;
      case 's':  ox = cx;      oy = bb.miny; break;
    }
  }

  let hx = cx, hy = cy;
  switch (handle){
    case 'nw': hx = bb.minx; hy = bb.miny; break;
    case 'ne': hx = bb.maxx; hy = bb.miny; break;
    case 'se': hx = bb.maxx; hy = bb.maxy; break;
    case 'sw': hx = bb.minx; hy = bb.maxy; break;
    case 'e':  hx = bb.maxx; hy = cy;      break;
    case 'w':  hx = bb.minx; hy = cy;      break;
    case 'n':  hx = cx;      hy = bb.miny; break;
    case 's':  hx = cx;      hy = bb.maxy; break;
  }

  const denomX = (hx - ox);
  const denomY = (hy - oy);
  let sx = (Math.abs(denomX) < 1e-9) ? 1 : (cursor.x - ox) / denomX;
  let sy = (Math.abs(denomY) < 1e-9) ? 1 : (cursor.y - oy) / denomY;

  if (handle === 'e' || handle === 'w'){
    if (shiftUniform) sy = sx; else sy = 1;
  } else if (handle === 'n' || handle === 's'){
    if (shiftUniform) sx = sy; else sx = 1;
  } else if (shiftUniform){
    const u = Math.abs(Math.abs(sx) > Math.abs(sy) ? sx : sy);
    sx = Math.sign(sx) * u; sy = Math.sign(sy) * u;
  }

  if (!Number.isFinite(sx)) sx = 1;
  if (!Number.isFinite(sy)) sy = 1;
  return { sx, sy, ox, oy };
}

function ensureObjectPoints(st){
  if (!st || st.kind !== 'path') return;
  const pts = st.pts;
  if (!Array.isArray(pts) || pts.length === 0) return;
  if (typeof pts[0] === 'number'){
    const out = [];
    for (let i = 0; i < pts.length; i += 3){
      out.push({ x: +pts[i] || 0, y: +pts[i+1] || 0, p: pts[i+2] != null ? +pts[i+2] : 0.5 });
    }
    st.pts = out;
    st.n = null;
    st._chunks = st._chunks || null;
  }
}

function cursorForHandle(h){
  switch(h){
    case 'n': case 's': return 'ns-resize';
    case 'e': case 'w': return 'ew-resize';
    case 'ne': case 'sw': return 'nesw-resize';
    case 'nw': case 'se': return 'nwse-resize';
    case 'rot': return 'grab';
    default: return 'default';
  }
}

export class SelectTool {
  constructor({ canvas, ctx, camera, state }){
    this.canvas = canvas; this.ctx = ctx; this.camera = camera; this.state = state;

    this.downScreen = null;
    this.downWorld  = null;
    this.dragging   = false;
    this.additive   = false;
    this.strictContain = false;
    this.mode = null;   
    this.handle = null;    
    this.startBBox = null;
    this.beforeSnaps = null;
    this._rotPivot = null; 
    this._rotAngle0 = 0;   
    this._currentXF = null;
    this._lastXFSticky = null;
  }

  _setMarqueeRect(r){ this.state._marquee = r; scheduleRender(); }
  _clearMarquee(){ if (this.state._marquee){ this.state._marquee = null; scheduleRender(); } }

  _applySelection(newSet, additive){
    const sel = this.state.selection;
    if (!additive) sel.clear();
    for (const s of newSet){
      if (additive && sel.has(s)) sel.delete(s);
      else sel.add(s);
    }
    scheduleRender();
  }

  _selectMarquee(rect, additive, contain=false){
    const cands = query(grid, rect);
    const picked = new Set();
    for (const s of cands){
      const pad = (s.w || 0) * 1.0;
      const bb = { minx: s.bbox.minx - pad, miny: s.bbox.miny - pad, maxx: s.bbox.maxx + pad, maxy: s.bbox.maxy + pad };
      if (contain ? bboxContains(rect, bb) : bboxIntersects(bb, rect)) {
        picked.add(s);
      }
    }
    this._applySelection(picked, additive);
  }

  onPointerDown(e){
    if (e.button !== 0) return;
    try { this.canvas.setPointerCapture(e.pointerId); } catch {}
    const r = this.canvas.getBoundingClientRect();
    this.downScreen = { x: e.clientX - r.left, y: e.clientY - r.top };
    this.downWorld  = this.camera.screenToWorld(this.downScreen);
    this.dragging = false;
    this.additive = !!e.shiftKey;
    this.strictContain = !!e.altKey;
    if (this.state.selection && this.state.selection.size){
      const bb = selectionBBoxWorld(this.state);
      if (bb){
        const h = hitHandle(this.downWorld, bb, this.camera);
        if (h === 'rot'){
          this.mode = 'rotate'; this.handle = 'rot'; this.startBBox = bb;
          const cx = (bb.minx + bb.maxx)/2, cy = (bb.miny + bb.maxy)/2;
          this._rotPivot = { x:cx, y:cy };
          this._rotAngle0 = Math.atan2(this.downWorld.y - cy, this.downWorld.x - cx);
        } else if (h){
          this.mode = 'scale'; this.handle = h; this.startBBox = bb;
        } else if (pointInRect(this.downWorld, bb)) {
          this.mode = 'move'; this.startBBox = bb;
        } else {
          this.mode = null;
        }
        if (this.mode){
          for (const s of this.state.selection) ensureObjectPoints(s);
          this.beforeSnaps = [];
          for (const s of this.state.selection) {
            this.beforeSnaps.push({ stroke: s, before: snapshotGeometry(s) });
          }
          setDeferIndex(true);
          this.state._transformActive = true;
          this.state._activeHandle = this.handle || null;
          this.canvas.style.cursor = (this.mode === 'rotate') ? 'grabbing'
                                 : (this.mode === 'move') ? 'move'
                                 : cursorForHandle(this.handle);
          this._currentXF = null;
          scheduleRender();
          return;
        }
      }
    }
  }

  onPointerMove(e){
    const r = this.canvas.getBoundingClientRect();
    const scr = { x: e.clientX - r.left, y: e.clientY - r.top };
    if (!this.downScreen && this.state.selection && this.state.selection.size){
      const bb = selectionBBoxWorld(this.state);
      if (bb){
        const world = this.camera.screenToWorld(scr);
        const h = hitHandle(world, bb, this.camera) || (pointInRect(world, bb) ? 'move' : null);
        const cursor = h ? (h === 'move' ? 'move' : cursorForHandle(h)) : '';
        this.canvas.style.cursor = cursor;
        const as = (h === 'move') ? null : h; 
        if (this.state._hoverHandle !== as){
          this.state._hoverHandle = as;
          scheduleRender();
        }
      }
    }

    if (!this.downScreen) return;
    const dxs = scr.x - this.downScreen.x, dys = scr.y - this.downScreen.y;
    if (!this.dragging && (dxs*dxs + dys*dys) >= MOVE_TOL_SQ) this.dragging = true;
    const world = this.camera.screenToWorld(scr);
    if (this.mode && this.dragging){
      const shiftUniform = !!e.shiftKey;
      const altCenter = !!e.altKey || !!e.metaKey;

      let xf;
      if (this.mode === 'move'){
        const ox = this.startBBox.minx; const oy = this.startBBox.miny;
        const dx = world.x - this.downWorld.x;
        const dy = world.y - this.downWorld.y;
        xf = { sx:1, sy:1, ox, oy, tx:dx, ty:dy, theta:0 };
      } else if (this.mode === 'scale'){
        xf = scaleFromHandle(this.handle, this.startBBox, world, shiftUniform, altCenter);
        xf.tx = 0; xf.ty = 0; xf.theta = 0;
      } else { 
        const pivot = this._rotPivot || { x: (this.startBBox.minx+this.startBBox.maxx)/2, y: (this.startBBox.miny+this.startBBox.maxy)/2 };
        const aNow = Math.atan2(world.y - pivot.y, world.x - pivot.x);
        let dAng = aNow - this._rotAngle0;
        if (shiftUniform){ // snap to 15°
          const snap = Math.PI / 12;
          dAng = Math.round(dAng / snap) * snap;
        }
        xf = { sx:1, sy:1, ox:pivot.x, oy:pivot.y, tx:0, ty:0, theta:dAng };
      }
      this._currentXF = { sx:+xf.sx||1, sy:+xf.sy||1, tx:+xf.tx||0, ty:+xf.ty||0, theta:+xf.theta||0 };

      for (const m of this.beforeSnaps){
        const s = m.stroke;
        if (m.before.kind === 'path'){
          if (m.before.pts){
            if (!s.pts || s.pts.length < m.before.pts.length) s.pts = new Float32Array(m.before.pts.length);
            s.pts.set(m.before.pts); s.n = m.before.pts.length;
            s._chunks = m.before.chunks?.map(c => ({ i0:c.i0, i1:c.i1, bbox:{...c.bbox} })) || [];
          } else {
            s.pts = m.before.ptsObj.map(p => ({ x:p.x, y:p.y, p:p.p })); s.n = null;
            s._chunks = m.before.chunks?.map(c => ({ i0:c.i0, i1:c.i1, bbox:{...c.bbox} })) || [];
          }
        } else {
          s.start = { ...m.before.start }; s.end = { ...m.before.end };
        }
        s.w = m.before.w; s.bbox = { ...m.before.bbox };
        transformStrokeGeom(s, xf);
      }

      if (this.mode === 'rotate') this.canvas.style.cursor = 'grabbing';
      else if (this.mode === 'move') this.canvas.style.cursor = 'move';
      else this.canvas.style.cursor = cursorForHandle(this.handle);

      scheduleRender();
      return;
    }

    if (!this.mode && this.dragging){
      const w = this.camera.screenToWorld(scr);
      this._setMarqueeRect(rectFrom(this.downWorld, w));
    }
  }

  onPointerUp(e){
    if (e.button !== 0) return;

    const wasDragging = this.dragging;
    const hadMode = this.mode;

    if (hadMode){
      const muts = [];
      for (const m of this.beforeSnaps){
        muts.push({
          stroke: m.stroke,
          before: m.before,
          after: snapshotGeometry(m.stroke)
        });
        update(grid, m.stroke);
      }
      this.state.history?.pushTransform?.(muts);
      setDeferIndex(false);
      this.state._transformActive = false;
      this.state._activeHandle = null;
      this.canvas.style.cursor = '';
      this._lastXFSticky = this._currentXF ? { ...this._currentXF } : null;
      this._currentXF = null;
      scheduleRender();
    } else {
      if (!wasDragging){
        const rct = this.canvas.getBoundingClientRect();
        const screen = { x: e.clientX - rct.left, y: e.clientY - rct.top };
        const world  = this.camera.screenToWorld(screen);
        const pickR = pickRadius(this.camera, this.state);
        const hit = pickTopAt(world, pickR, { camera: this.camera, state: this.state });
        if (hit){
          this._applySelection(new Set([hit]), this.additive);
        } else if (!this.additive) {
          this.state.selection.clear(); scheduleRender();
        }
      } else {
        const rect = this.state._marquee;
        if (rect) {
          // Alt/Option during release or at drag start => inside-only
          const contain = !!e.altKey || this.strictContain;
          this._selectMarquee(rect, this.additive, contain);
        }
      }
    }

    this._clearMarquee();
    this.beforeSnaps = null;
    this.mode = null; this.handle = null; this.startBBox = null;
    this.downScreen = null; this.downWorld = null; this.dragging = false; this.additive = false;
    this._rotPivot = null; this._rotAngle0 = 0;
    this.strictContain = false;
  }

  cancel(){
    this._clearMarquee();
    this.beforeSnaps = null;
    this.mode = null; this.handle = null; this.startBBox = null;
    this.downScreen = null; this.downWorld = null; this.dragging = false; this.additive = false;
    this._rotPivot = null; this._rotAngle0 = 0;
    this.canvas.style.cursor = '';
    setDeferIndex(false);
    this.state._transformActive = false;
    this.state._hoverHandle = null;
    this.state._activeHandle = null;
    this._currentXF = null;
  }
  setPoseA(){
    const sel = this.state.selection ? Array.from(this.state.selection) : [];
    if (!sel.length) return;
    const xf = this._currentXF || { sx:1, sy:1, theta:0, tx:0, ty:0 };
    for (const s of sel){
      s.react2 = s.react2 || {};
      s.react2.enabled = true;

      s.react2.A = {
        sx: Number.isFinite(+xf.sx) ? +xf.sx : 1,
        sy: Number.isFinite(+xf.sy) ? +xf.sy : 1,
        theta: Number.isFinite(+xf.theta) ? +xf.theta : 0,
        tx: Number.isFinite(+xf.tx) ? +xf.tx : 0,
        ty: Number.isFinite(+xf.ty) ? +xf.ty : 0
      };
    }
    scheduleRender();
  }

  setPoseB(){
    const sel = this.state.selection ? Array.from(this.state.selection) : [];
    if (!sel.length) return;
    const xf = this._currentXF || this._lastXFSticky || { sx:1, sy:1, theta:0, tx:0, ty:0 };
    for (const s of sel){
      s.react2 = s.react2 || {};
      s.react2.enabled = true;
      if (!s.react2.A) s.react2.A = { sx:1, sy:1, theta:0, tx:0, ty:0 };

      s.react2.B = {
        sx: Number.isFinite(+xf.sx) ? +xf.sx : 1,
        sy: Number.isFinite(+xf.sy) ? +xf.sy : 1,
        theta: Number.isFinite(+xf.theta) ? +xf.theta : 0,
        tx: Number.isFinite(+xf.tx) ? +xf.tx : 0,
        ty: Number.isFinite(+xf.ty) ? +xf.ty : 0
      };
    }

    const muts = [];
    for (const s of sel){
      const A = s.react2.A || { sx:1, sy:1, theta:0, tx:0, ty:0 };
      const B = s.react2.B || { sx:1, sy:1, theta:0, tx:0, ty:0 };
      const before = snapshotGeometry(s);
      const cx = (s.bbox.minx + s.bbox.maxx) * 0.5;
      const cy = (s.bbox.miny + s.bbox.maxy) * 0.5;
      const ib = {
        sx: 1 / Math.max(1e-6, B.sx || 1),
        sy: 1 / Math.max(1e-6, B.sy || 1),
        theta: -(B.theta || 0),
        ox: cx, oy: cy,
        tx: -(B.tx || 0),
        ty: -(B.ty || 0)
      };
      transformStrokeGeom(s, ib);
      const a = {
        sx: Math.max(1e-6, A.sx || 1),
        sy: Math.max(1e-6, A.sy || 1),
        theta: (A.theta || 0),
        ox: cx, oy: cy,
        tx: (A.tx || 0),
        ty: (A.ty || 0)
      };
      transformStrokeGeom(s, a);

      muts.push({ stroke: s, before, after: snapshotGeometry(s) });
      update(grid, s);
    }
    this.state.history?.pushTransform?.(muts);
    this._lastXFSticky = null;
    this._currentXF = null;

    scheduleRender();
  }

}