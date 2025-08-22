// src/utils/picker.js
import { query, grid } from '../spatial_index.js';
import { state as globalState } from '../state.js';
import { isHitConsideringBake, distancePxConsideringBake } from './hit.js';

/**
 * Topmost-hit picker: queries spatial index (with fallback),
 * sorts candidates by recency, and uses centralized hit-test.
 */
export function pickTopAt(world, rWorld, { camera, state, bake = globalState._bake }){
  const pickRect = { minx:world.x - rWorld, miny:world.y - rWorld, maxx:world.x + rWorld, maxy:world.y + rWorld };

  let candidates = Array.from(query(grid, pickRect) || []);
  if (!candidates.length){
    // Fallback to most-recent strokes (zoom-aware)
    const arr = state.strokes;
    const extra = Math.max(0, Math.floor(200 * Math.log2(Math.max(1, camera.scale) + 1)));
    const N = 200 + extra;
    candidates = arr.slice(Math.max(0, arr.length - N));
  }
  // Prefer more recent strokes when multiple overlap
  candidates.sort((a,b) => (b.timestamp||0) - (a.timestamp||0));
  const hits = [];
  for (const s of candidates){
    if (isHitConsideringBake(s, world, rWorld, bake, camera)){
      const dpx = distancePxConsideringBake(s, world, camera, bake);
      hits.push({ s, dpx });
    }
  }
  if (!hits.length) return null;
  hits.sort((a,b) => {
    const dd = a.dpx - b.dpx;
    if (Math.abs(dd) > 0.5) return dd;                  // prefer closest in screen px
    return (b.s.timestamp||0) - (a.s.timestamp||0);     // then most recent
  });
  return hits[0].s || null;
 }