// main.js
const { app, BrowserWindow, nativeTheme, protocol } = require('electron');
const path = require('path');
const isDev = !app.isPackaged;

app.setAppUserModelId('com.yourname.deepcanvas');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'Deep Canvas',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f1115' : '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });

  win.loadFile(path.join(__dirname, 'app', 'index.html'));

  if (isDev) {
    win.webContents.openDevTools({ mode: 'detach' });
  }

  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('Renderer crashed:', details);
  });
}

app.whenReady().then(() => {
  protocol.registerFileProtocol('app', (request, cb) => {
    const url = request.url.replace('app://', '');
    cb({ path: path.normalize(`${__dirname}/${url}`) });
  });

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
