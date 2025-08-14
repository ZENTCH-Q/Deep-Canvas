// src/utils/pick.js

const EPS = 1e-8;

/** Convert a small screen tolerance (px) into world units (defaults to ~0.9px). */
export function worldTol(camera, px = 0.9){
  return px / Math.max(EPS, camera.scale);
}

/** Consistent pick radius: max(base px radius, fraction of brush size). */
export function pickRadius(camera, state, basePx = 12, sizeFactor = 0.9){
  const baseR   = basePx / Math.max(EPS, camera.scale);
  const size    = (state?.settings?.size ?? 6) / Math.max(EPS, camera.scale);
  return Math.max(baseR, size * sizeFactor);
}

/** Handle sizing (world) derived from screen px constants. */
export const handleWorldRadius      = (camera, px = 10) => px / Math.max(EPS, camera.scale);
export const rotHandleWorldOffset   = (camera, px = 28) => px / Math.max(EPS, camera.scale);
export const rotHandleWorldRadius   = (camera, px = 8)  => px / Math.max(EPS, camera.scale);
