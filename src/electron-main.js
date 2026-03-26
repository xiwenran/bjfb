const { app, BrowserWindow, dialog, shell } = require('electron');
const { startServer, stopServer, getServerState } = require('./server.js');

let mainWindow = null;

async function ensureServerReady() {
  const current = getServerState().server;
  if (current && current.port) {
    return current;
  }

  return startServer({
    port: 0,
    host: '127.0.0.1',
  });
}

async function createMainWindow() {
  const serverInfo = await ensureServerReady();
  const appUrl = `http://${serverInfo.host}:${serverInfo.port}`;

  const win = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1100,
    minHeight: 760,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#f2f2f7',
    title: '知发',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.once('ready-to-show', () => {
    win.show();
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, targetUrl) => {
    const currentOrigin = new URL(appUrl).origin;
    if (!targetUrl.startsWith(currentOrigin)) {
      event.preventDefault();
      shell.openExternal(targetUrl);
    }
  });

  await win.loadURL(appUrl);
  return win;
}

async function bootstrap() {
  try {
    mainWindow = await createMainWindow();
    mainWindow.on('closed', () => {
      mainWindow = null;
    });
  } catch (error) {
    dialog.showErrorBox('桌面版启动失败', error.message);
    await stopServer().catch(() => {});
    app.quit();
  }
}

app.whenReady().then(() => {
  bootstrap();

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = await createMainWindow();
      mainWindow.on('closed', () => {
        mainWindow = null;
      });
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  void stopServer();
});
