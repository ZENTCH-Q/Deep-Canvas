// src/tools/index.js
import { DrawTool } from './draw.js';
import { EraseTool } from './erase.js';
import { PanTool } from './pan.js';
import { DeleteTool } from './delete.js';
import { LineTool, RectTool, EllipseTool } from './shapes.js';
import { SelectTool } from './select.js';
import { PaintTool } from './paint.js';

export function createTool(name, deps){
  // deps now may include { overlay }
  switch(name){
    case 'select': return new SelectTool(deps);
    case 'paint': return new PaintTool(deps);
    case 'draw': return new DrawTool(deps);
    case 'erase': return new EraseTool(deps);
    case 'delete': return new DeleteTool(deps);
    case 'pan': return new PanTool(deps);
    case 'line': return new LineTool(deps);
    case 'rect': return new RectTool(deps);
    case 'ellipse': return new EllipseTool(deps);
    default: return new DrawTool(deps);
  }
}
