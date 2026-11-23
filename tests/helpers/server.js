'use strict';

/**
 * 测试辅助：起一个隔离的本地服务实例。
 * - BILI_DATA_ROOT 指向临时目录，绝不碰用户真实配置与下载目录
 * - 先占一个空闲端口再释放，降低 7788 被占用导致端口顺延、找不到实例的概率
 */

const { spawn } = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SERVER = path.join(__dirname, '..', '..', 'server.js');

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function ping(port, timeoutMs = 150) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: ctrl.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

async function startServer(extraEnv = {}, opts = {}) {
  const port = await getFreePort();
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-test-'));

  // 允许测试预置 config.json 等文件（迁移场景）
  if (typeof opts.seed === 'function') {
    try {
      opts.seed(dataRoot);
    } catch {}
  }

  const useIpc = Object.prototype.hasOwnProperty.call(opts, 'ipcKey');
  const stdio = useIpc ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'];

  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PORT: String(port),
      NO_OPEN: '1',
      BILI_DATA_ROOT: dataRoot,
      ...extraEnv,
    },
    stdio,
    windowsHide: true,
  });

  // 模拟 Electron 主进程：收到索取就下发改系统密钥
  if (useIpc) {
    child.on('message', (msg) => {
      if (msg && msg.type === 'secret:key:request') {
        try {
          child.send({ type: 'secret:key:reply', key: opts.ipcKey });
        } catch {}
      }
    });
  }

  let log = '';
  child.stdout.on('data', (d) => (log += d.toString()));
  child.stderr.on('data', (d) => (log += d.toString()));

  const deadline = Date.now() + 15000;
  let up = false;
  while (Date.now() < deadline) {
    if (await ping(port)) {
      up = true;
      break;
    }
    if (child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 120));
  }

  if (!up) {
    child.kill();
    throw new Error(`服务未启动（端口 ${port}）\n${log.slice(0, 800)}`);
  }

  return {
    port,
    base: `http://127.0.0.1:${port}`,
    dataRoot,
    child,
    log: () => log,
    async stop() {
      child.kill();
      await new Promise((r) => setTimeout(r, 80));
      try {
        fs.rmSync(dataRoot, { recursive: true, force: true });
      } catch {}
    },
  };
}

async function getJSON(url, init) {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

module.exports = { startServer, getFreePort, getJSON };
