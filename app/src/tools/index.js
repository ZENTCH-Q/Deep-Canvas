// src/tools/index.js
import { DrawTool } from './draw.js';
import { EraseTool } from './erase.js';
import { PanTool } from './pan.js';
import { DeleteTool } from './delete.js';
import { LineTool, RectTool, EllipseTool } from './shapes.js';
import { SelectTool } from './select.js';
import { PaintTool } from './paint.js';
import { TextTool } from './text.js';

export function createTool(name, deps){
  if (!deps.state._selectToolSingleton) {
    deps.state._selectToolSingleton = new SelectTool(deps);
  }
  switch(name){
    case 'select': return deps.state._selectToolSingleton;
    case 'paint': return new PaintTool(deps);
    case 'draw': return new DrawTool(deps);
    case 'text'  : return new TextTool(deps);
    case 'erase': return new EraseTool(deps);
    case 'delete': return new DeleteTool(deps);
    case 'pan': return new PanTool(deps);
    case 'line': return new LineTool(deps);
    case 'rect': return new RectTool(deps);
    case 'ellipse': return new EllipseTool(deps);
    default: return new DrawTool(deps);
  }
}
