const { app, BrowserWindow, shell, dialog } = require('electron');
const { spawn } = require('child_process');
const path = require('path');

const PORT = Number(process.env.PORT || 7788);
const BASE = `http://127.0.0.1:${PORT}`;

let serverProc = null;
let win = null;
let listenUrl = null;

/** 用独立的 Node 进程跑本地服务，避免阻塞 Electron 主进程 */
function startServer() {
  const serverPath = path.join(__dirname, '..', 'server.js');
  serverProc = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      PORT: String(PORT),
      NO_OPEN: '1',            // 由 Electron 自己显示窗口，不再唤起浏览器
      BILI_APP_IPC: '1',       // 让服务回报实际监听地址
      ELECTRON_RUN_AS_NODE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let stdout = '';
  serverProc.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
    const found = stdout.match(/LISTENING=(http:\/\/127\.0\.0\.1:\d+)/);
    if (found) listenUrl = found[1];
  });
  // 有管道就有人读，别让服务端日志把缓冲区堵满
  serverProc.stderr.resume();
  serverProc.on('error', (e) => {
    dialog.showErrorBox('启动失败', '本地服务无法启动：' + e.message);
  });
}

/** 轮询等待服务可用 */
async function waitForServer(timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (listenUrl) {
      try {
        const res = await fetch(listenUrl + '/api/ping');
        if (res.ok) return true;
      } catch {
        /* 还没起来，继续等 */
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 720,
    minHeight: 560,
    backgroundColor: '#0a0c11',
    title: '哔哩提取器',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 站外链接用系统浏览器打开
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  const ok = await waitForServer();
  if (!ok) {
    dialog.showErrorBox('启动超时', '本地服务未能启动，请检查端口 7788 是否被占用。');
    app.quit();
    return;
  }
  win.loadURL(listenUrl || BASE);
}

app.whenReady().then(() => {
  startServer();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (serverProc) serverProc.kill();
  app.quit();
});

app.on('before-quit', () => {
  if (serverProc) serverProc.kill();
});
