// utils/geometry.js
export function rectsIntersect(a, b){
  return !(a.maxx < b.minx || a.minx > b.maxx || a.maxy < b.miny || a.miny > b.maxy);
}
export function growBBox(b, p){
  if (p.x < b.minx) b.minx = p.x; if (p.x > b.maxx) b.maxx = p.x;
  if (p.y < b.miny) b.miny = p.y; if (p.y > b.maxy) b.maxy = p.y;
}
export function bboxFromPoints(p){ return { minx:p.x, miny:p.y, maxx:p.x, maxy:p.y }; }
