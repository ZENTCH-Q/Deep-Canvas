// src/utils/path_chunks.js
// Build & maintain per-path chunk bounding boxes for fast hit testing.

import { distSqPointSeg } from './common.js';

const STRIDE = 3; // [x, y, pressure?]
const MIN_SEG_FOR_CHUNKING = 24;  // below this, chunking isn't worth it
const DEFAULT_SEG_PER_CHUNK = 48; // ~ how many segments per chunk

export function computePathBBoxTyped(pts, n){
  let minx=Infinity, miny=Infinity, maxx=-Infinity, maxy=-Infinity;
  for (let i=0;i<n;i+=STRIDE){
    const x=pts[i], y=pts[i+1];
    if (x<minx) minx=x; if (y<miny) miny=y;
    if (x>maxx) maxx=x; if (y>maxy) maxy=y;
  }
  if (!Number.isFinite(minx)) return {minx:0,miny:0,maxx:0,maxy:0};
  return {minx, miny, maxx, maxy};
}

export function computePathBBoxObj(arr){
  let minx=Infinity, miny=Infinity, maxx=-Infinity, maxy=-Infinity;
  for (let i=0;i<arr.length;i++){
    const p = arr[i]; const x=p.x, y=p.y;
    if (x<minx) minx=x; if (y<miny) miny=y;
    if (x>maxx) maxx=x; if (y>maxy) maxy=y;
  }
  if (!Number.isFinite(minx)) return {minx:0,miny:0,maxx:0,maxy:0};
  return {minx, miny, maxx, maxy};
}

/**
 * Build chunk list for a path stroke:
 * - For typed array paths: indices are point indices in the typed array (multiples of STRIDE)
 * - For object-array paths: indices are array positions
 * Each chunk stores [i0, i1] inclusive range of points and its bbox.
 */
export function buildPathChunks(stroke, segPerChunk = DEFAULT_SEG_PER_CHUNK){
  if (!stroke || stroke.kind !== 'path') return null;

  // Typed array case
  if (stroke.n != null && stroke.pts && typeof stroke.pts.BYTES_PER_ELEMENT === 'number'){
    const n = stroke.n;
    const segCount = Math.max(0, Math.floor(n/STRIDE) - 1);
    if (segCount < MIN_SEG_FOR_CHUNKING) return [];
    const step = Math.max(1, segPerChunk);
    const chunks = [];
    let i0 = 0;
    while (i0 + STRIDE < n){
      const lastSegEnd = Math.min(n-STRIDE, i0 + step*STRIDE);
      let minx=Infinity, miny=Infinity, maxx=-Infinity, maxy=-Infinity;
      for (let i=i0; i<=lastSegEnd; i+=STRIDE){
        const x=stroke.pts[i], y=stroke.pts[i+1];
        if (x<minx) minx=x; if (y<miny) miny=y;
        if (x>maxx) maxx=x; if (y>maxy) maxy=y;
      }
      chunks.push({ i0, i1: lastSegEnd, bbox:{minx, miny, maxx, maxy} });
      if (lastSegEnd === n-STRIDE) break;
      i0 = lastSegEnd;
    }
    return chunks;
  }

  // Object point array case
  if (Array.isArray(stroke.pts) && stroke.pts.length > 1){
    const segCount = stroke.pts.length - 1;
    if (segCount < MIN_SEG_FOR_CHUNKING) return [];
    const step = Math.max(1, segPerChunk);
    const chunks = [];
    let i0 = 0;
    while (i0 < stroke.pts.length){
      const i1 = Math.min(stroke.pts.length - 1, i0 + step);
      let minx=Infinity, miny=Infinity, maxx=-Infinity, maxy=-Infinity;
      for (let i=i0; i<=i1; i++){
        const p=stroke.pts[i]; const x=p.x, y=p.y;
        if (x<minx) minx=x; if (y<miny) miny=y;
        if (x>maxx) maxx=x; if (y>maxy) maxy=y;
      }
      chunks.push({ i0, i1, bbox:{minx, miny, maxx, maxy} });
      if (i1 === stroke.pts.length - 1) break;
      i0 = i1;
    }
    return chunks;
  }

  return [];
}

export function ensurePathChunks(stroke, segPerChunk = DEFAULT_SEG_PER_CHUNK){
  if (!stroke || stroke.kind !== 'path') return;
  if (!stroke._chunks || !Array.isArray(stroke._chunks)){
    stroke._chunks = buildPathChunks(stroke, segPerChunk);
  }
  // (Re)compute full bbox if missing or stale
  if (!stroke.bbox){
    if (stroke.n != null && stroke.pts && typeof stroke.pts.BYTES_PER_ELEMENT === 'number'){
      stroke.bbox = computePathBBoxTyped(stroke.pts, stroke.n);
    } else if (Array.isArray(stroke.pts)){
      stroke.bbox = computePathBBoxObj(stroke.pts);
    }
  }
}

export function rechunkPath(stroke, segPerChunk = DEFAULT_SEG_PER_CHUNK){
  if (!stroke || stroke.kind !== 'path') return;
  stroke._chunks = buildPathChunks(stroke, segPerChunk);
}

export function rechunkAllPaths(state, segPerChunk = DEFAULT_SEG_PER_CHUNK){
  if (!state || !state.strokes) return;
  for (const s of state.strokes){
    if (s?.kind === 'path') {
      s._chunks = buildPathChunks(s, segPerChunk);
    }
  }
}
