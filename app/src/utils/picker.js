// src/utils/picker.js
import { query, grid } from '../spatial_index.js';
import { state as globalState } from '../state.js';
import { isHitConsideringBake } from './hit.js';

/**
 * Topmost-hit picker: queries spatial index (with fallback),
 * sorts candidates by recency, and uses centralized hit-test.
 */
export function pickTopAt(world, rWorld, { camera, state, bake = globalState._bake }){
  const pickRect = { minx:world.x - rWorld, miny:world.y - rWorld, maxx:world.x + rWorld, maxy:world.y + rWorld };

  let candidates = Array.from(query(grid, pickRect));
  if (!candidates.length){
    // Fallback to most-recent strokes (zoom-aware)
    const arr = state.strokes;
    const extra = Math.max(0, Math.floor(200 * Math.log2(Math.max(1, camera.scale) + 1)));
    const N = 200 + extra;
    candidates = arr.slice(Math.max(0, arr.length - N));
  }
  candidates.sort((a,b) => (b.timestamp||0) - (a.timestamp||0));

  return candidates.find(s => isHitConsideringBake(s, world, rWorld, bake, camera)) || null;
}
