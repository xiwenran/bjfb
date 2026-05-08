const path = require('path');
const { execSync } = require('child_process');
const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const { startServer, stopServer, getServerState } = require('./server.js');

// 防止上传 OSS 时 ReadStream EPIPE 弹 Electron 错误弹窗。
// 当 OSS 服务端因 403/400 等原因关闭连接时，Node.js ReadStream 会产生
// EPIPE error，如果没有显式 error 监听，会作为 uncaughtException 冒泡。
// axios 会通过 socket error 路径独立 reject Promise，上传失败会正常报错，
// 不需要 EPIPE 额外弹窗。其他 uncaughtException 继续默认处理。
process.on('uncaughtException', (err) => {
  if (err.code === 'EPIPE') {
    console.error('[warn] EPIPE suppressed in main process:', err.message);
    return;
  }
  // 不是 EPIPE，走 Electron 默认（弹窗）
  throw err;
});

let mainWindow = null;
const WINDOW_ICON_PATH = path.join(__dirname, '..', 'build', 'icon.png');

// 启动前检查 3210 是否被知发自己的孤儿进程占用，如果是就自动清理。
// 只在 macOS 上执行，只 kill 命令行含 server.js 的 node 进程（知发特征），
// 不会误 kill 其他 .app 实例（它们的服务跑在 Electron 进程内，命令行不含 server.js）。
function clearZhifaOrphanOnPort3210() {
  if (process.platform !== 'darwin') return;
  try {
    const pid = execSync('lsof -ti :3210 2>/dev/null', { encoding: 'utf8' }).trim();
    if (!pid) return;
    const cmd = execSync(`ps -p ${pid} -o command= 2>/dev/null`, { encoding: 'utf8' }).trim();
    if (cmd.includes('node') && cmd.includes('server.js')) {
      execSync(`kill ${pid} 2>/dev/null`);
      // 等端口真正释放
      execSync('sleep 0.5');
    }
  } catch (_) {
    // lsof/ps 失败或端口已空闲，忽略
  }
}

async function ensureServerReady() {
  const current = getServerState().server;
  if (current && current.port) {
    return current;
  }

  clearZhifaOrphanOnPort3210();

  try {
    return await startServer({
      port: 3210,
      host: '127.0.0.1',
    });
  } catch (err) {
    if (err.code === 'EADDRINUSE') {
      throw new Error(
        '端口 3210 被其他程序占用，知发无法启动。\n\n' +
        '请在终端执行以下命令，然后重新打开知发：\n' +
        'lsof -ti :3210 | xargs kill -9'
      );
    }
    throw err;
  }
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
    icon: WINDOW_ICON_PATH,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
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
  app.setName('知发');
  bootstrap();

  ipcMain.handle('dialog:openFolder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory']
    });
    return result.canceled ? null : result.filePaths[0];
  });

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
