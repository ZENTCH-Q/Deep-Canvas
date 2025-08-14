// utils/common.js

export const EPS = 1e-8;
export const DPR_CAP = 2.5;

export const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
export const isFiniteNum = (n) => Number.isFinite(n);

// Pixel↔world convenience
export const pxToWorld = (camera, px) => px / Math.max(EPS, camera.scale);
export const worldToPx = (camera, w) => w * Math.max(1, camera.scale);

// Mouse-move tolerance in screen px (same logic you repeated)
export function moveTol(camera) {
  const s = Math.max(1, camera.scale);
  const t = 0.6 * (1 + Math.log2(s));
  return Math.min(t, 8);
}

// Ensure an object has a stable id
export function ensureId(o) {
  if (!o.id) o.id = (crypto?.randomUUID?.() || ('s-' + Math.random().toString(36).slice(2, 10)));
  return o.id;
}

// Distance^2 from point→segment (works with {x,y} or [x,y])
export function distSqPointSeg(p, a, b) {
  const px = p.x ?? p[0], py = p.y ?? p[1];
  const ax = a.x ?? a[0], ay = a.y ?? a[1];
  const bx = b.x ?? b[0], by = b.y ?? b[1];

  const vx = bx - ax, vy = by - ay;
  const wx = px - ax, wy = py - ay;

  const c1 = vx * wx + vy * wy;
  if (c1 <= 0) return (px - ax) ** 2 + (py - ay) ** 2;

  const c2 = vx * vx + vy * vy;
  if (c2 <= c1) return (px - bx) ** 2 + (py - by) ** 2;

  const t = clamp(c1 / Math.max(1e-12, c2), 0, 1);
  const qx = ax + t * vx, qy = ay + t * vy;
  return (px - qx) ** 2 + (py - qy) ** 2;
}

// Basic rect hit
export const pointInRect = (p, r) =>
  p.x >= r.minx && p.x <= r.maxx && p.y >= r.miny && p.y <= r.maxy;

// Consistent pick radius: (12px) vs brush size
export function pickRadius(camera, state, basePx = 12, sizeFactor = 0.9) {
  const baseR = basePx / Math.max(EPS, camera.scale);
  const sizeHint = (state?.settings?.size ?? 6) / Math.max(EPS, camera.scale);
  return Math.max(baseR, sizeHint * sizeFactor);
}
