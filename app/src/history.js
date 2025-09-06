// src/history.js
import { removeStroke, clearAll, snapshotGeometry, restoreGeometry } from './strokes.js';
import { scheduleRender, markDirty } from './state.js';
import { insert, rebuildIndex, grid, update } from './spatial_index.js';

export function attachHistory(state){
  state.history = {
    pushAdd(s){ state.undoStack.push({ type:'add', stroke:s }); state.redoStack.length = 0; },
    pushAddGroup(arr){ state.undoStack.push({ type:'addGroup', strokes: arr.slice() }); state.redoStack.length = 0; },
    pushClear(prev){ state.undoStack.push({ type:'clear', prev }); state.redoStack.length = 0; },
    pushDelete(stroke, index){ state.undoStack.push({ type:'delete', stroke, index }); state.redoStack.length = 0; },
    pushDeleteGroup(strokes, indices){
      state.undoStack.push({ type:'deleteGroup', strokes: strokes.slice(), indices: indices.slice() });
      state.redoStack.length = 0;
    },
    pushTransform(muts){ state.undoStack.push({ type:'transform', muts }); state.redoStack.length = 0; },
    pushBackground(prev, next){
      state.undoStack.push({ type:'background', prev, next });
      state.redoStack.length = 0;
    },
    pushStyle(stroke, prev, next){
      state.undoStack.push({ type:'style', stroke, prev, next });
      state.redoStack.length = 0;
    },
    undo(){ undo(state); },
    redo(){ redo(state); },
  };
}

function undo(state){
  const op = state.undoStack.pop(); if(!op) return;
  switch(op.type){
    case 'background': {
      if (op.prev) {
        state.background = { ...op.prev };
        markDirty(); scheduleRender();
      }
      state.redoStack.push(op);
      break;
    }
    case 'style': {
      if (op.stroke) {
        if (op.prev?.color != null) op.stroke.color = op.prev.color;
        if (op.prev?.alpha != null) op.stroke.alpha = op.prev.alpha;
        if (op.prev?.fill  != null) op.stroke.fill  = op.prev.fill;
        if (op.prev?.fontSize != null) op.stroke.fontSize = op.prev.fontSize;
        markDirty(); scheduleRender();
      }
      state.redoStack.push(op);
      break;
    }
    case 'add': {
      removeStroke(state, op.stroke);
      state.redoStack.push(op);
      break;
    }
    case 'addGroup': {
      for (let i=0;i<op.strokes.length;i++) removeStroke(state, op.strokes[i]);
      state.redoStack.push(op);
      break;
    }
    case 'clear': {
      const current = [...state.strokes];
      state.strokes.splice(0, state.strokes.length, ...op.prev);
      rebuildIndex(grid, state.strokes);
      markDirty(); scheduleRender();
      state.redoStack.push({ type:'clear', prev: current });
      break;
    }
    case 'delete': {
      const i = Math.max(0, Math.min(op.index ?? state.strokes.length, state.strokes.length));
      state.strokes.splice(i, 0, op.stroke);
      insert(grid, op.stroke);
      markDirty(); scheduleRender();
      state.redoStack.push(op);
      break;
    }
    case 'deleteGroup': {
      for (let k=0; k<op.strokes.length; k++){
        const s = op.strokes[k];
        const i = Math.max(0, Math.min(op.indices[k] ?? state.strokes.length, state.strokes.length));
        state.strokes.splice(i, 0, s);
        insert(grid, s);
      }
      markDirty(); scheduleRender();
      state.redoStack.push(op);
      break;
    }
    case 'transform': {
      for (const m of op.muts){ restoreGeometry(m.stroke, m.before); update(grid, m.stroke); }
      markDirty(); scheduleRender();
      state.redoStack.push(op);
      break;
    }
  }
}

function redo(state){
  const op = state.redoStack.pop(); if(!op) return;
  switch(op.type){
    case 'background': {
      if (op.next) {
        state.background = { ...op.next };
        markDirty(); scheduleRender();
      }
      state.undoStack.push(op);
      break;
    }
    case 'style': {
      if (op.stroke) {
        if (op.next?.color != null) op.stroke.color = op.next.color;
        if (op.next?.alpha != null) op.stroke.alpha = op.next.alpha;
        if (op.next?.fill  != null) op.stroke.fill  = op.next.fill;
        if (op.next?.fontSize != null) op.stroke.fontSize = op.next.fontSize;
        markDirty(); scheduleRender();
      }
      state.undoStack.push(op);
      break;
    }
    case 'add': {
      state.strokes.push(op.stroke);
      insert(grid, op.stroke);
      markDirty(); scheduleRender();
      state.undoStack.push(op);
      break;
    }
    case 'addGroup': {
      for (const s of op.strokes) {
        state.strokes.push(s);
        insert(grid, s);
      }
      markDirty(); scheduleRender();
      state.undoStack.push(op);
      break;
    }
    case 'clear': {
      const prev=[...state.strokes];
      clearAll(state);
      state.undoStack.push({ type:'clear', prev });
      break;
    }
    case 'delete': {
      removeStroke(state, op.stroke);
      state.undoStack.push(op);
      break;
    }
    case 'deleteGroup': {
      for (const s of op.strokes) removeStroke(state, s);
      markDirty(); scheduleRender();
      state.undoStack.push(op);
      break;
    }
    case 'transform': {
      for (const m of op.muts){ restoreGeometry(m.stroke, m.after); update(grid, m.stroke); }
      markDirty(); scheduleRender();
      state.undoStack.push(op);
      break;
    }
  }
}

