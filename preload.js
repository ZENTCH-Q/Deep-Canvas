const { contextBridge } = require('electron');
const fs = require('fs');
const path = require('path');

function listPlugins() {
  try {
    const dir = path.join(__dirname, 'app', 'plugins');
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.js'));
    return files.map(f => `../plugins/${f}`);
  } catch {
    return [];
  }
}

contextBridge.exposeInMainWorld('pluginHost', {
  list: listPlugins
});
