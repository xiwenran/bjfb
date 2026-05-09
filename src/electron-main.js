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

process.on('unhandledRejection', (reason) => {
  console.error('[fatal] unhandledRejection:', reason);
  const msg = reason instanceof Error ? reason.message : String(reason);
  dialog.showErrorBox('知发遇到意外错误', msg);
  app.quit();
});

let mainWindow = null;
const WINDOW_ICON_PATH = path.join(__dirname, '..', 'build', 'icon.png');

// 启动前检查 3210 是否被知发自己的孤儿进程占用，如果是就自动清理。
// 识别知发相关进程：node+server.js（npm start）、Electron（npm run desktop）、知发.app
function clearZhifaOrphanOnPort3210() {
  if (process.platform !== 'darwin') return;
  try {
    const pids = execSync('lsof -ti :3210 2>/dev/null', { encoding: 'utf8' }).trim();
    if (!pids) return;
    for (const pid of pids.split('\n').map(p => p.trim()).filter(Boolean)) {
      try {
        const cmd = execSync(`ps -p ${pid} -o command= 2>/dev/null`, { encoding: 'utf8' }).trim();
        const isZhifa = (cmd.includes('node') && cmd.includes('server.js'))
          || cmd.includes('知发')
          || (cmd.toLowerCase().includes('electron') && (cmd.includes('zhifa') || cmd.includes('知发')));
        if (isZhifa) {
          execSync(`kill ${pid} 2>/dev/null`);
        }
      } catch (_) { /* 单个 pid 失败忽略，继续处理其他 */ }
    }
    // 等端口真正释放（最多 2 秒，每次单独 try-catch 避免空输出 exit code 被外层吞）
    for (let i = 0; i < 4; i++) {
      execSync('sleep 0.5');
      let stillUsed = false;
      try {
        const out = execSync('lsof -ti :3210 2>/dev/null', { encoding: 'utf8' }).trim();
        stillUsed = !!out;
      } catch (_) {
        stillUsed = false; // lsof exit code 非 0 = 端口已空闲
      }
      if (!stillUsed) break;
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

let _isQuitting = false;
app.on('before-quit', (event) => {
  if (_isQuitting) return;
  _isQuitting = true;
  event.preventDefault();
  // 等服务关闭（最多 2 秒），确保端口释放后再退出
  Promise.race([
    stopServer(),
    new Promise((resolve) => setTimeout(resolve, 2000)),
  ]).finally(() => {
    app.exit(0);
  });
});
